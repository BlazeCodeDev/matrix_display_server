#pragma once

#include "esp_http_server.h"
#include <cstring>
#include <cctype>
#include <string>

// Framebuffer shared with the "Designer" preset lambda in matrixdisplay.yaml.
// 64x32 RGB, one byte per channel, row-major.
#define MD_WIDTH 64
#define MD_HEIGHT 32
uint8_t md_framebuffer[MD_WIDTH * MD_HEIGHT * 3] = {0};
volatile bool md_has_design = false;

// Values exposed from Home Assistant via the `set_metric` API service, e.g. cpu load.
// Rendered as a small status line at the bottom of the display.
#define MD_MAX_METRICS 4
struct MdMetric { std::string label; float value; bool active; };
MdMetric md_metrics[MD_MAX_METRICS];

void md_set_metric(const char *key, float value) {
  for (int i = 0; i < MD_MAX_METRICS; i++) {
    if (md_metrics[i].active && md_metrics[i].label == key) {
      md_metrics[i].value = value;
      return;
    }
  }
  for (int i = 0; i < MD_MAX_METRICS; i++) {
    if (!md_metrics[i].active) {
      md_metrics[i] = { key, value, true };
      return;
    }
  }
  md_metrics[0] = { key, value, true };
}

std::string md_metrics_line() {
  std::string out;
  char buf[24];
  for (int i = 0; i < MD_MAX_METRICS; i++) {
    if (!md_metrics[i].active) continue;
    if (!out.empty()) out += " ";
    if (md_metrics[i].value == (int) md_metrics[i].value) {
      snprintf(buf, sizeof(buf), "%s:%d", md_metrics[i].label.c_str(), (int) md_metrics[i].value);
    } else {
      snprintf(buf, sizeof(buf), "%s:%.1f", md_metrics[i].label.c_str(), md_metrics[i].value);
    }
    out += buf;
  }
  return out;
}

namespace {

httpd_handle_t md_server = nullptr;

// Find "key":<int> starting at or after `from` and return its value.
bool md_extract_int(const std::string &s, size_t from, const char *key, int &out) {
  std::string needle = std::string("\"") + key + "\":";
  size_t p = s.find(needle, from);
  if (p == std::string::npos) return false;
  p += needle.length();
  while (p < s.length() && s[p] == ' ') p++;
  bool neg = false;
  if (p < s.length() && s[p] == '-') { neg = true; p++; }
  int val = 0;
  bool any = false;
  while (p < s.length() && isdigit((unsigned char) s[p])) {
    val = val * 10 + (s[p] - '0');
    p++;
    any = true;
  }
  if (!any) return false;
  out = neg ? -val : val;
  return true;
}

// Apply the first frame of a matrix_display_server /api/pixels payload to md_framebuffer.
// Payload shape: {"frames":[[{"x":0,"y":0,"r":255,"g":0,"b":0}, ...], ...], ...}
void md_apply_payload(const std::string &body) {
  memset(md_framebuffer, 0, sizeof(md_framebuffer));

  size_t frames_pos = body.find("\"frames\":");
  if (frames_pos == std::string::npos) return;

  size_t outer_start = body.find('[', frames_pos);
  if (outer_start == std::string::npos) return;
  size_t frame_start = body.find('[', outer_start + 1);
  if (frame_start == std::string::npos) return;

  // Find the matching close bracket for this first frame's pixel array.
  int depth = 0;
  size_t frame_end = std::string::npos;
  for (size_t i = frame_start; i < body.length(); i++) {
    if (body[i] == '[') depth++;
    else if (body[i] == ']') {
      depth--;
      if (depth == 0) { frame_end = i; break; }
    }
  }
  if (frame_end == std::string::npos) return;

  size_t pos = frame_start;
  while (true) {
    size_t obj_start = body.find('{', pos);
    if (obj_start == std::string::npos || obj_start > frame_end) break;
    size_t obj_end = body.find('}', obj_start);
    if (obj_end == std::string::npos || obj_end > frame_end) break;

    int x = -1, y = -1, r = 0, g = 0, b = 0;
    md_extract_int(body, obj_start, "x", x);
    md_extract_int(body, obj_start, "y", y);
    md_extract_int(body, obj_start, "r", r);
    md_extract_int(body, obj_start, "g", g);
    md_extract_int(body, obj_start, "b", b);

    if (x >= 0 && x < MD_WIDTH && y >= 0 && y < MD_HEIGHT) {
      int i = (y * MD_WIDTH + x) * 3;
      md_framebuffer[i] = (uint8_t) r;
      md_framebuffer[i + 1] = (uint8_t) g;
      md_framebuffer[i + 2] = (uint8_t) b;
    }

    pos = obj_end + 1;
  }

  md_has_design = true;
}

esp_err_t md_pixels_post_handler(httpd_req_t *req) {
  int total = req->content_len;
  if (total <= 0 || total > 200000) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Bad payload size");
    return ESP_FAIL;
  }

  std::string body;
  body.resize(total);
  int received = 0;
  while (received < total) {
    int r = httpd_req_recv(req, &body[received], total - received);
    if (r <= 0) {
      httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Read failed");
      return ESP_FAIL;
    }
    received += r;
  }

  md_apply_payload(body);

  httpd_resp_set_type(req, "application/json");
  httpd_resp_sendstr(req, "{\"success\":true}");
  return ESP_OK;
}

esp_err_t md_status_get_handler(httpd_req_t *req) {
  httpd_resp_set_type(req, "application/json");
  httpd_resp_sendstr(req, md_has_design ? "{\"hasDesign\":true}" : "{\"hasDesign\":false}");
  return ESP_OK;
}

}  // namespace

void matrix_designer_init() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 8080;
  config.stack_size = 8192;
  config.uri_match_fn = httpd_uri_match_wildcard;

  if (httpd_start(&md_server, &config) != ESP_OK) return;

  httpd_uri_t pixels_uri = {
    .uri = "/api/pixels",
    .method = HTTP_POST,
    .handler = md_pixels_post_handler,
    .user_ctx = nullptr
  };
  httpd_register_uri_handler(md_server, &pixels_uri);

  httpd_uri_t status_uri = {
    .uri = "/api/status",
    .method = HTTP_GET,
    .handler = md_status_get_handler,
    .user_ctx = nullptr
  };
  httpd_register_uri_handler(md_server, &status_uri);
}
