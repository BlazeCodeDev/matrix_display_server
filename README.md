# LED Matrix Designer Server

A web-based LED matrix designer with ESP32 API for dynamic display updates.

## Features

- Visual editor for 64x32 LED matrices
- Multiple screens with easy switching
- Animation support with multiple frames
- Real-time preview
- ESP32 API endpoints for dynamic updates
- Pixel-based rendering (no fonts needed on ESP32)

## Quick Start

### Using Docker

```bash
# Build and run
docker-compose up -d

# Or build manually
docker build -t led-matrix-server .
docker run -d -p 3000:3000 -v led-matrix-data:/app/data led-matrix-server
```

### Without Docker

```bash
npm install
npm start
```

Access the web UI at: http://localhost:3000

## ESP32 API Endpoints

### GET /api/esp/status
Check server status and active screen.

```json
{
  "hasActiveScreen": true,
  "activeScreenId": "abc123",
  "activeScreenName": "Welcome",
  "screenCount": 3,
  "timestamp": 1702900000000
}
```

### GET /api/esp/pixels
Get pixel data as JSON (easier to parse).

```json
{
  "id": "abc123",
  "name": "Welcome",
  "isAnimated": false,
  "frameDelay": 200,
  "frameCount": 1,
  "frames": [
    [
      {"x": 10, "y": 5, "r": 255, "g": 0, "b": 0},
      {"x": 11, "y": 5, "r": 255, "g": 0, "b": 0}
    ]
  ]
}
```

### GET /api/esp/binary
Get pixel data as compact binary (more efficient).

Format:
```
[frameCount:1 byte]
[frameDelay:2 bytes LE]
For each frame:
  [pixelCount:2 bytes LE]
  For each pixel:
    [x:1][y:1][r:1][g:1][b:1]
```

### GET /api/esp/screens
List all available screens.

### POST /api/esp/active/:id
Set the active screen.

---

## Reference ESP32 Config (matrixdisplay.yaml)

`matrixdisplay.yaml` in this repo is a complete, single-file ESPHome config for a 64x32
HUB75 matrix (no companion `.h` file needed). It polls `GET /api/esp/pixels` every 3s and
renders the active screen; when nothing has been designed yet it shows "DESIGN ME" and the
configured server URL.

- **Matrix Server URL** — a text entity (settable from Home Assistant or the ESPHome device
  page) pointing at this server, e.g. `http://192.168.1.100:3000`. Nothing to configure on
  the web UI side for this — the device polls on its own schedule.
- **Auto Cycle Screens** — in the web UI's Settings (gear icon), automatically rotate the
  active screen on an interval; the display picks up the change on its next poll.
- **View ESPHome YAML** — the `</>` button in the header always shows the current
  `matrixdisplay.yaml` content (served from `GET /api/esphome-yaml`) with a copy button, so
  you can paste it straight into ESPHome.
- **Home Assistant metrics** — call `esphome.matrix_display_set_metric` from an HA automation
  with a `key` (e.g. `"cpu"`) and `value` (float) to show arbitrary live values (CPU load,
  temperature, etc.) as a small status line at the bottom of the display, regardless of what's
  designed.
- Auto brightness (LDR-based), Animation Speed, and a Display Power switch are also exposed
  as Home Assistant entities.

---

## ESP32 Example Code (ESPHome)

```yaml
# ESPHome configuration for dynamic LED matrix

esphome:
  name: led-matrix
  platform: ESP32
  board: esp32dev

wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password

# HTTP Request component
http_request:
  useragent: esphome/led-matrix
  timeout: 10s

# Global variables
globals:
  - id: pixel_data
    type: std::vector<std::tuple<uint8_t, uint8_t, uint8_t, uint8_t, uint8_t>>
  - id: frame_count
    type: int
    initial_value: '1'
  - id: frame_delay
    type: int
    initial_value: '200'
  - id: current_frame
    type: int
    initial_value: '0'
  - id: last_fetch
    type: unsigned long
    initial_value: '0'

# Interval to fetch new data
interval:
  - interval: 5s
    then:
      - http_request.get:
          url: http://YOUR_SERVER_IP:3000/api/esp/pixels
          on_response:
            then:
              - lambda: |-
                  if (response->status_code == 200) {
                    // Parse JSON response
                    // Update pixel_data, frame_count, frame_delay
                    ESP_LOGD("matrix", "Fetched pixel data");
                  }

display:
  - platform: addressable_light
    id: led_matrix
    addressable_light_id: matrix_light
    width: 64
    height: 32
    update_interval: 50ms
    lambda: |-
      static unsigned long last_frame = 0;
      unsigned long now = millis();
      
      // Advance frame for animations
      if (id(frame_count) > 1 && (now - last_frame) >= id(frame_delay)) {
        id(current_frame) = (id(current_frame) + 1) % id(frame_count);
        last_frame = now;
      }
      
      it.fill(Color::BLACK);
      
      // Draw pixels from current frame
      for (auto& pixel : id(pixel_data)) {
        uint8_t x = std::get<0>(pixel);
        uint8_t y = std::get<1>(pixel);
        uint8_t r = std::get<2>(pixel);
        uint8_t g = std::get<3>(pixel);
        uint8_t b = std::get<4>(pixel);
        it.draw_pixel_at(x, y, Color(r, g, b));
      }
```

---

## ESP32 Example Code (Arduino)

```cpp
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Adafruit_GFX.h>
#include <Adafruit_NeoMatrix.h>

const char* ssid = "YOUR_WIFI";
const char* password = "YOUR_PASSWORD";
const char* serverUrl = "http://YOUR_SERVER_IP:3000/api/esp/pixels";

#define PIN 5
#define WIDTH 64
#define HEIGHT 32

Adafruit_NeoMatrix matrix = Adafruit_NeoMatrix(WIDTH, HEIGHT, PIN,
  NEO_MATRIX_TOP + NEO_MATRIX_LEFT + NEO_MATRIX_COLUMNS + NEO_MATRIX_ZIGZAG,
  NEO_GRB + NEO_KHZ800);

struct Pixel {
  uint8_t x, y, r, g, b;
};

std::vector<std::vector<Pixel>> frames;
int frameCount = 0;
int frameDelay = 200;
int currentFrame = 0;
unsigned long lastFrameTime = 0;
unsigned long lastFetchTime = 0;

void setup() {
  Serial.begin(115200);
  
  matrix.begin();
  matrix.setBrightness(40);
  matrix.fillScreen(0);
  matrix.show();
  
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected");
  
  fetchPixelData();
}

void fetchPixelData() {
  if (WiFi.status() != WL_CONNECTED) return;
  
  HTTPClient http;
  http.begin(serverUrl);
  
  int httpCode = http.GET();
  if (httpCode == HTTP_CODE_OK) {
    String payload = http.getString();
    
    DynamicJsonDocument doc(65536);
    DeserializationError error = deserializeJson(doc, payload);
    
    if (!error) {
      frames.clear();
      frameCount = doc["frameCount"];
      frameDelay = doc["frameDelay"];
      
      JsonArray framesArray = doc["frames"];
      for (JsonArray framePixels : framesArray) {
        std::vector<Pixel> frame;
        for (JsonObject p : framePixels) {
          Pixel pixel;
          pixel.x = p["x"];
          pixel.y = p["y"];
          pixel.r = p["r"];
          pixel.g = p["g"];
          pixel.b = p["b"];
          frame.push_back(pixel);
        }
        frames.push_back(frame);
      }
      
      Serial.printf("Loaded %d frames, %d ms delay\n", frameCount, frameDelay);
    }
  }
  
  http.end();
}

void loop() {
  unsigned long now = millis();
  
  // Fetch new data every 5 seconds
  if (now - lastFetchTime > 5000) {
    fetchPixelData();
    lastFetchTime = now;
  }
  
  // Advance animation frame
  if (frameCount > 1 && now - lastFrameTime > frameDelay) {
    currentFrame = (currentFrame + 1) % frameCount;
    lastFrameTime = now;
  }
  
  // Draw current frame
  matrix.fillScreen(0);
  
  if (frames.size() > currentFrame) {
    for (const Pixel& p : frames[currentFrame]) {
      matrix.drawPixel(p.x, p.y, matrix.Color(p.r, p.g, p.b));
    }
  }
  
  matrix.show();
  delay(10);
}
```

---

## ESP32 Binary Protocol (More Efficient)

For lower bandwidth usage, use `/api/esp/binary`:

```cpp
void fetchBinaryData() {
  HTTPClient http;
  http.begin("http://YOUR_SERVER_IP:3000/api/esp/binary");
  
  int httpCode = http.GET();
  if (httpCode == HTTP_CODE_OK) {
    int len = http.getSize();
    uint8_t* buffer = (uint8_t*)malloc(len);
    
    WiFiClient* stream = http.getStreamPtr();
    stream->readBytes(buffer, len);
    
    // Parse binary format
    int offset = 0;
    frameCount = buffer[offset++];
    frameDelay = buffer[offset] | (buffer[offset + 1] << 8);
    offset += 2;
    
    frames.clear();
    for (int f = 0; f < frameCount; f++) {
      int pixelCount = buffer[offset] | (buffer[offset + 1] << 8);
      offset += 2;
      
      std::vector<Pixel> frame;
      for (int i = 0; i < pixelCount; i++) {
        Pixel p;
        p.x = buffer[offset++];
        p.y = buffer[offset++];
        p.r = buffer[offset++];
        p.g = buffer[offset++];
        p.b = buffer[offset++];
        frame.push_back(p);
      }
      frames.push_back(frame);
    }
    
    free(buffer);
  }
  
  http.end();
}
```

---

## Web UI Usage

1. Open http://localhost:3000 in your browser
2. Create a new screen with the "+ New" button
3. Draw using the tools (pixel, line, rectangle, circle, text)
4. Add animation frames with "+ Frame"
5. Click "Save" to persist your design
6. Click "Set Active" to make a screen the current one for ESP32
7. The ESP32 will automatically fetch the active screen's pixel data

## Environment Variables

- `PORT` - Server port (default: 3000)

## Data Persistence

Screen data is stored in `/app/data/screens.json` inside the container.
Mount a volume to persist data across container restarts.
