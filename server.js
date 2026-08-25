const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'screens.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const YAML_FILE = path.join(__dirname, 'matrixdisplay.yaml');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Initialize data file
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading data:', e);
  }
  return { screens: [], activeScreenId: null };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Settings (currently just the auto-cycle config) persistence
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading settings:', e);
  }
  return { cycle: { enabled: false, intervalSeconds: 30 }, homeAssistant: { url: '', token: '' } };
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// Auto-cycle: periodically advance the active screen. The ESP32 polls
// /api/esp/pixels on its own schedule, so there is nothing to push here.
let cycleTimer = null;

async function cycleToNextScreen() {
  const data = loadData();
  if (data.screens.length < 2) return;
  const startIndex = data.screens.findIndex(s => s.id === data.activeScreenId);
  // Walk forward through the list (wrapping) and land on the first screen
  // that isn't manually excluded and isn't currently hidden by a rule. If
  // every screen is skipped, leave activeScreenId as-is — the esp
  // endpoints already fall back to the no-active-screen placeholder for a
  // hidden active screen.
  for (let step = 1; step <= data.screens.length; step++) {
    const candidate = data.screens[(startIndex + step) % data.screens.length];
    if (candidate.excludeFromCycle) continue;
    if (!(await isScreenHidden(candidate))) {
      data.activeScreenId = candidate.id;
      saveData(data);
      return;
    }
  }
}

function restartCycleTimer() {
  if (cycleTimer) clearInterval(cycleTimer);
  cycleTimer = null;
  const settings = loadSettings();
  const cycle = settings.cycle || {};
  if (cycle.enabled) {
    const ms = Math.max(5, cycle.intervalSeconds || 30) * 1000;
    cycleTimer = setInterval(() => { cycleToNextScreen().catch(e => console.error('Cycle error:', e)); }, ms);
  }
}

// Home Assistant REST API proxy. Credentials stay server-side; the browser
// never sees the access token.
async function haFetch(pathname) {
  const settings = loadSettings();
  const ha = settings.homeAssistant || {};
  if (!ha.url || !ha.token) return null;

  const base = ha.url.replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${base}${pathname}`, {
      headers: { Authorization: `Bearer ${ha.token}` },
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// HA entity states are sometimes a plain number ("21.5") but sometimes come
// with a unit baked directly into the value itself ("42 W", "$1,234.50",
// "73%") rather than split out into a separate unit_of_measurement
// attribute. Pull out the numeric part regardless of where the unit sits,
// treating a comma as a thousands separator (not a decimal point) since HA's
// own state strings are always dot-decimal.
function parseEntityNumber(raw) {
  if (raw == null) return NaN;
  const s = String(raw).trim().replace(/(\d),(?=\d{3}(\D|$))/g, '$1');
  const match = s.match(/-?\d+(\.\d+)?/);
  return match ? parseFloat(match[0]) : NaN;
}

// A screen can carry "hide rules" so it's skipped by auto-cycle and the
// device falls back to the no-active-screen placeholder if it's the one
// currently active — e.g. don't show the grill-temp screen once the probe
// goes unavailable, or the AC screen once the room's above a threshold.
// A screen with no rules is never hidden; with any rules, matching ANY one
// of them hides it (OR, not AND) — that matches how people describe these
// ("hide if it's unknown, OR if it's above 80").
async function ruleMatches(rule) {
  const state = await haFetch(`/api/states/${encodeURIComponent(rule.entityId)}`);
  // Can't reach HA or the entity doesn't exist — as good as "unavailable"
  // for a state-equality check; a numeric comparison just can't fire.
  const rawState = state ? state.state : 'unavailable';
  if (rule.type === 'above' || rule.type === 'below') {
    const num = parseEntityNumber(rawState);
    if (Number.isNaN(num) || rule.value == null) return false;
    return rule.type === 'above' ? num > rule.value : num < rule.value;
  }
  return rawState.toLowerCase() === String(rule.value ?? '').toLowerCase();
}

async function isScreenHidden(screen) {
  const rules = screen.hideRules || [];
  for (const rule of rules) {
    if (rule.entityId && await ruleMatches(rule)) return true;
  }
  return false;
}

// Pick the color for the highest colorRules threshold the value meets or
// exceeds, e.g. [{threshold:80,color:red}] recolors once value >= 80.
// Falls back to the element's base color if no rule matches (or none set).
function applyColorRules(baseColor, colorRules, value) {
  if (!colorRules || !colorRules.length || value == null || Number.isNaN(value)) return baseColor;
  let best = null;
  for (const rule of colorRules) {
    if (value >= rule.threshold && (!best || rule.threshold > best.threshold)) best = rule;
  }
  return best ? best.color : baseColor;
}

// Resolve an entity-bound element against its live Home Assistant state:
// text elements get the formatted state string (and optional threshold-based
// color), bars get a clamped numeric value. Static (non-entity-bound)
// elements pass through unchanged.
async function resolveElement(el) {
  if (!el.entityId) return el;

  if (el.type === 'text') {
    const state = await haFetch(`/api/states/${encodeURIComponent(el.entityId)}`);
    if (!state) return { ...el, text: el.text || '?' };
    const unit = state.attributes?.unit_of_measurement;
    const text = unit ? `${state.state}${unit}` : state.state;
    const value = parseEntityNumber(state.state);
    const color = applyColorRules(el.color, el.colorRules, value);
    return { ...el, text, color };
  }

  if (el.type === 'bar') {
    const state = await haFetch(`/api/states/${encodeURIComponent(el.entityId)}`);
    if (!state) return el; // keep last known value rather than zeroing the bar
    const value = parseEntityNumber(state.state);
    if (Number.isNaN(value)) return el;
    return { ...el, value };
  }

  return el;
}

async function resolveFrameElements(frameElements) {
  return Promise.all(frameElements.map(resolveElement));
}

// API Routes

// Get all screens (metadata only)
app.get('/api/screens', (req, res) => {
  const data = loadData();
  const screens = data.screens.map(s => ({
    id: s.id,
    name: s.name,
    isAnimated: s.isAnimated,
    frameCount: s.frames?.length || 1,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    hideRules: s.hideRules || [],
    excludeFromCycle: s.excludeFromCycle || false
  }));
  res.json({ screens, activeScreenId: data.activeScreenId });
});

// Reorder screens — also determines auto-cycle order, since that just walks
// this same array. Body: { order: [screenId, ...] }, must be a permutation
// of every existing screen id.
app.post('/api/screens/reorder', (req, res) => {
  const data = loadData();
  const order = req.body.order;
  const valid = Array.isArray(order)
    && order.length === data.screens.length
    && new Set(order).size === data.screens.length
    && order.every(id => data.screens.some(s => s.id === id));
  if (!valid) {
    return res.status(400).json({ error: 'order must contain every existing screen id exactly once' });
  }
  const byId = new Map(data.screens.map(s => [s.id, s]));
  data.screens = order.map(id => byId.get(id));
  saveData(data);
  res.json({ screens: data.screens.map(s => ({ id: s.id, name: s.name })) });
});

// Get single screen with full data
app.get('/api/screens/:id', (req, res) => {
  const data = loadData();
  const screen = data.screens.find(s => s.id === req.params.id);
  if (!screen) {
    return res.status(404).json({ error: 'Screen not found' });
  }
  res.json(screen);
});

// Create new screen
app.post('/api/screens', (req, res) => {
  const data = loadData();
  const screen = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    name: req.body.name || 'Untitled',
    frames: req.body.frames || [[]],
    isAnimated: req.body.isAnimated || false,
    frameDelay: req.body.frameDelay || 200,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  data.screens.push(screen);
  if (!data.activeScreenId) {
    data.activeScreenId = screen.id;
  }
  saveData(data);
  res.json(screen);
});

// Update screen
app.put('/api/screens/:id', (req, res) => {
  const data = loadData();
  const index = data.screens.findIndex(s => s.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Screen not found' });
  }
  data.screens[index] = {
    ...data.screens[index],
    name: req.body.name ?? data.screens[index].name,
    frames: req.body.frames ?? data.screens[index].frames,
    isAnimated: req.body.isAnimated ?? data.screens[index].isAnimated,
    frameDelay: req.body.frameDelay ?? data.screens[index].frameDelay,
    hideRules: req.body.hideRules ?? data.screens[index].hideRules,
    excludeFromCycle: req.body.excludeFromCycle ?? data.screens[index].excludeFromCycle,
    updatedAt: new Date().toISOString()
  };
  saveData(data);
  res.json(data.screens[index]);
});

// Delete screen
app.delete('/api/screens/:id', (req, res) => {
  const data = loadData();
  const index = data.screens.findIndex(s => s.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Screen not found' });
  }
  data.screens.splice(index, 1);
  if (data.activeScreenId === req.params.id) {
    data.activeScreenId = data.screens[0]?.id || null;
  }
  saveData(data);
  res.json({ success: true });
});

// Set active screen
app.post('/api/active/:id', (req, res) => {
  const data = loadData();
  const screen = data.screens.find(s => s.id === req.params.id);
  if (!screen) {
    return res.status(404).json({ error: 'Screen not found' });
  }
  data.activeScreenId = req.params.id;
  saveData(data);
  res.json({ activeScreenId: data.activeScreenId });
});

// Get active screen ID
app.get('/api/active', (req, res) => {
  const data = loadData();
  res.json({ activeScreenId: data.activeScreenId });
});

// ============ Settings ============

// Get settings. The Home Assistant token is never sent back to the browser.
app.get('/api/settings', (req, res) => {
  const settings = loadSettings();
  const ha = settings.homeAssistant || {};
  res.json({ ...settings, homeAssistant: { url: ha.url || '', hasToken: !!ha.token } });
});

// Update settings
app.put('/api/settings', (req, res) => {
  const settings = loadSettings();
  if (req.body.cycle) {
    settings.cycle = {
      enabled: !!req.body.cycle.enabled,
      intervalSeconds: Math.max(5, parseInt(req.body.cycle.intervalSeconds) || 30)
    };
  }
  if (req.body.homeAssistant) {
    const existing = settings.homeAssistant || {};
    settings.homeAssistant = {
      url: (req.body.homeAssistant.url ?? existing.url ?? '').trim(),
      // Only overwrite the stored token if a new one was actually provided,
      // so re-saving the URL doesn't require re-entering the token.
      token: req.body.homeAssistant.token ? req.body.homeAssistant.token.trim() : (existing.token || '')
    };
  }
  saveSettings(settings);
  restartCycleTimer();
  const ha = settings.homeAssistant || {};
  res.json({ ...settings, homeAssistant: { url: ha.url || '', hasToken: !!ha.token } });
});

// Search Home Assistant entities (for the designer's entity picker)
app.get('/api/ha/entities', async (req, res) => {
  const states = await haFetch('/api/states');
  if (!states) return res.status(502).json({ error: 'Could not reach Home Assistant. Check URL/token in Settings.' });
  const q = (req.query.q || '').toLowerCase();
  const matches = states
    .map(s => ({ entityId: s.entity_id, name: s.attributes?.friendly_name || s.entity_id, state: s.state }))
    .filter(e => !q || e.entityId.toLowerCase().includes(q) || e.name.toLowerCase().includes(q))
    .slice(0, 50);
  res.json({ entities: matches });
});

// Current state of a single entity (for live preview while designing)
app.get('/api/ha/state/:entityId', async (req, res) => {
  const state = await haFetch(`/api/states/${encodeURIComponent(req.params.entityId)}`);
  if (!state) return res.status(502).json({ error: 'Could not reach Home Assistant' });
  const unit = state.attributes?.unit_of_measurement;
  res.json({ state: state.state, unit: unit || '', text: unit ? `${state.state}${unit}` : state.state });
});

// Serve the ESPHome yaml so the web UI can always show the current config
app.get('/api/esphome-yaml', (req, res) => {
  try {
    res.type('text/plain').send(fs.readFileSync(YAML_FILE, 'utf8'));
  } catch (e) {
    res.status(404).json({ error: 'matrixdisplay.yaml not found' });
  }
});

// ============ ESP32 API Endpoints ============

// Bitmap font definitions for ESP32
const FONTS = {
  tiny: {
    height: 5, width: 3,
    chars: {
      'A': [0b010, 0b101, 0b111, 0b101, 0b101],
      'B': [0b110, 0b101, 0b110, 0b101, 0b110],
      'C': [0b011, 0b100, 0b100, 0b100, 0b011],
      'D': [0b110, 0b101, 0b101, 0b101, 0b110],
      'E': [0b111, 0b100, 0b110, 0b100, 0b111],
      'F': [0b111, 0b100, 0b110, 0b100, 0b100],
      'G': [0b011, 0b100, 0b101, 0b101, 0b011],
      'H': [0b101, 0b101, 0b111, 0b101, 0b101],
      'I': [0b111, 0b010, 0b010, 0b010, 0b111],
      'J': [0b001, 0b001, 0b001, 0b101, 0b010],
      'K': [0b101, 0b110, 0b100, 0b110, 0b101],
      'L': [0b100, 0b100, 0b100, 0b100, 0b111],
      'M': [0b101, 0b111, 0b111, 0b101, 0b101],
      'N': [0b101, 0b111, 0b111, 0b111, 0b101],
      'O': [0b010, 0b101, 0b101, 0b101, 0b010],
      'P': [0b110, 0b101, 0b110, 0b100, 0b100],
      'Q': [0b010, 0b101, 0b101, 0b110, 0b011],
      'R': [0b110, 0b101, 0b110, 0b101, 0b101],
      'S': [0b011, 0b100, 0b010, 0b001, 0b110],
      'T': [0b111, 0b010, 0b010, 0b010, 0b010],
      'U': [0b101, 0b101, 0b101, 0b101, 0b011],
      'V': [0b101, 0b101, 0b101, 0b101, 0b010],
      'W': [0b101, 0b101, 0b111, 0b111, 0b101],
      'X': [0b101, 0b101, 0b010, 0b101, 0b101],
      'Y': [0b101, 0b101, 0b010, 0b010, 0b010],
      'Z': [0b111, 0b001, 0b010, 0b100, 0b111],
      '0': [0b010, 0b101, 0b101, 0b101, 0b010],
      '1': [0b010, 0b110, 0b010, 0b010, 0b111],
      '2': [0b110, 0b001, 0b010, 0b100, 0b111],
      '3': [0b110, 0b001, 0b010, 0b001, 0b110],
      '4': [0b101, 0b101, 0b111, 0b001, 0b001],
      '5': [0b111, 0b100, 0b110, 0b001, 0b110],
      '6': [0b011, 0b100, 0b110, 0b101, 0b010],
      '7': [0b111, 0b001, 0b010, 0b010, 0b010],
      '8': [0b010, 0b101, 0b010, 0b101, 0b010],
      '9': [0b010, 0b101, 0b011, 0b001, 0b110],
      ' ': [0b000, 0b000, 0b000, 0b000, 0b000],
      '.': [0b000, 0b000, 0b000, 0b000, 0b010],
      ':': [0b000, 0b010, 0b000, 0b010, 0b000],
      '-': [0b000, 0b000, 0b111, 0b000, 0b000],
    }
  },
  small: {
    height: 7, width: 5,
    chars: {
      'A': [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
      'B': [0b11110, 0b10001, 0b11110, 0b10001, 0b10001, 0b10001, 0b11110],
      'C': [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
      'D': [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
      'E': [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
      'F': [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
      'G': [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
      'H': [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
      'I': [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111],
      'J': [0b00111, 0b00001, 0b00001, 0b00001, 0b10001, 0b10001, 0b01110],
      'K': [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
      'L': [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
      'M': [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
      'N': [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
      'O': [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
      'P': [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
      'Q': [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b01110, 0b00001],
      'R': [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
      'S': [0b01110, 0b10001, 0b10000, 0b01110, 0b00001, 0b10001, 0b01110],
      'T': [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
      'U': [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
      'V': [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
      'W': [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
      'X': [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
      'Y': [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
      'Z': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
      '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
      '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
      '2': [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
      '3': [0b01110, 0b10001, 0b00001, 0b00110, 0b00001, 0b10001, 0b01110],
      '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
      '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
      '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
      '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
      '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
      '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
      ' ': [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000],
      '.': [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b01100],
      ':': [0b00000, 0b01100, 0b01100, 0b00000, 0b01100, 0b01100, 0b00000],
      '-': [0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000],
    }
  },
  large: {
    height: 10, width: 7,
    chars: {
      'A': [0b0011100, 0b0100010, 0b1000001, 0b1000001, 0b1111111, 0b1000001, 0b1000001, 0b1000001, 0b1000001, 0b1000001],
      'B': [0b1111110, 0b1000001, 0b1000001, 0b1111110, 0b1000001, 0b1000001, 0b1000001, 0b1000001, 0b1000001, 0b1111110],
      'C': [0b0111110, 0b1000001, 0b1000000, 0b1000000, 0b1000000, 0b1000000, 0b1000000, 0b1000000, 0b1000001, 0b0111110],
      'D': [0b1111100, 0b1000010, 0b1000001, 0b1000001, 0b1000001, 0b1000001, 0b1000001, 0b1000001, 0b1000010, 0b1111100],
      'E': [0b1111111, 0b1000000, 0b1000000, 0b1000000, 0b1111110, 0b1000000, 0b1000000, 0b1000000, 0b1000000, 0b1111111],
      'F': [0b1111111, 0b1000000, 0b1000000, 0b1000000, 0b1111110, 0b1000000, 0b1000000, 0b1000000, 0b1000000, 0b1000000],
      '0': [0b0111110, 0b1000001, 0b1000011, 0b1000101, 0b1001001, 0b1010001, 0b1100001, 0b1000001, 0b1000001, 0b0111110],
      '1': [0b0001000, 0b0011000, 0b0101000, 0b0001000, 0b0001000, 0b0001000, 0b0001000, 0b0001000, 0b0001000, 0b0111110],
      ' ': [0b0000000, 0b0000000, 0b0000000, 0b0000000, 0b0000000, 0b0000000, 0b0000000, 0b0000000, 0b0000000, 0b0000000],
      ':': [0b0000000, 0b0000000, 0b0011000, 0b0011000, 0b0000000, 0b0000000, 0b0011000, 0b0011000, 0b0000000, 0b0000000],
    }
  }
};

const TEXT_SCROLL_SPEED = 6; // cells/second — must match public/index.html's copy

// Convert elements to pixel array. Text wider than maxWidth marquees across
// that window instead of running off the canvas, driven by wall-clock time
// so every poll (and the browser preview) reads a consistent, moving
// position rather than each starting its own animation from zero.
function getTextPixels(text, x, y, fontName, color, maxWidth) {
  const font = FONTS[fontName] || FONTS.small;
  const pixels = [];
  const upper = text.toUpperCase();
  const textWidth = upper.length * (font.width + 1);
  const scrolling = !!maxWidth && textWidth > maxWidth;
  const shift = scrolling
    ? maxWidth - Math.floor((Date.now() / 1000 * TEXT_SCROLL_SPEED) % (maxWidth + textWidth))
    : 0;

  let cursorX = 0;
  for (const char of upper) {
    const charData = font.chars[char] || font.chars[' '];
    if (charData) {
      for (let row = 0; row < font.height; row++) {
        for (let col = 0; col < font.width; col++) {
          if ((charData[row] >> (font.width - 1 - col)) & 1) {
            const windowLocalX = cursorX + col + shift;
            if (maxWidth && (windowLocalX < 0 || windowLocalX >= maxWidth)) continue;
            const px = x + windowLocalX;
            const py = y + row;
            if (px >= 0 && px < 64 && py >= 0 && py < 32) {
              pixels.push({ x: px, y: py, r: color.r, g: color.g, b: color.b });
            }
          }
        }
      }
    }
    cursorX += font.width + 1;
  }
  return pixels;
}

function getLinePoints(x1, y1, x2, y2) {
  const points = [];
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1;
  const sy = y1 < y2 ? 1 : -1;
  let err = dx - dy;
  let x = x1, y = y1;

  while (true) {
    points.push({ x, y });
    if (x === x2 && y === y2) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return points;
}

function getElementPixels(el) {
  const pixels = [];
  const color = el.color || { r: 255, g: 255, b: 255 };
  
  if (el.type === 'pixel') {
    pixels.push({ x: el.x, y: el.y, r: color.r, g: color.g, b: color.b });
  }
  else if (el.type === 'text') {
    return getTextPixels(el.text, el.x, el.y, el.fontSize, color, el.maxWidth);
  }
  else if (el.type === 'icon') {
    // The Material Symbols glyph is rasterized in the browser (canvas + the
    // webfont, neither available in Node) and shipped as a {row,col} bitmap
    // at save time; this just stamps it out relative to el.x/el.y.
    (el.bitmap || []).forEach(p => {
      const px = el.x + p.col;
      const py = el.y + p.row;
      if (px >= 0 && px < 64 && py >= 0 && py < 32) {
        pixels.push({ x: px, y: py, r: color.r, g: color.g, b: color.b });
      }
    });
  }
  else if (el.type === 'line') {
    const points = getLinePoints(el.x1, el.y1, el.x2, el.y2);
    points.forEach(p => pixels.push({ x: p.x, y: p.y, r: color.r, g: color.g, b: color.b }));
  }
  else if (el.type === 'rect') {
    for (let y = 0; y < el.height; y++) {
      for (let x = 0; x < el.width; x++) {
        if (el.filled || x === 0 || x === el.width - 1 || y === 0 || y === el.height - 1) {
          const px = el.x + x;
          const py = el.y + y;
          if (px >= 0 && px < 64 && py >= 0 && py < 32) {
            pixels.push({ x: px, y: py, r: color.r, g: color.g, b: color.b });
          }
        }
      }
    }
  }
  else if (el.type === 'circle') {
    for (let y = -el.r; y <= el.r; y++) {
      for (let x = -el.r; x <= el.r; x++) {
        const dist = Math.sqrt(x * x + y * y);
        const draw = el.filled ? dist <= el.r : Math.abs(dist - el.r) < 1;
        if (draw) {
          const px = el.cx + x;
          const py = el.cy + y;
          if (px >= 0 && px < 64 && py >= 0 && py < 32) {
            pixels.push({ x: px, y: py, r: color.r, g: color.g, b: color.b });
          }
        }
      }
    }
  }
  else if (el.type === 'bar') {
    const color2 = el.color2 || color;
    const min = el.min ?? 0;
    const max = el.max ?? 100;
    const value = el.value ?? min;
    const frac = max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)));
    const filledWidth = Math.round(frac * el.width);

    for (let dx = 0; dx < el.width; dx++) {
      const t = el.width > 1 ? dx / (el.width - 1) : 0;
      const full = {
        r: Math.round(color.r + (color2.r - color.r) * t),
        g: Math.round(color.g + (color2.g - color.g) * t),
        b: Math.round(color.b + (color2.b - color.b) * t)
      };
      const isFilled = dx < filledWidth;
      const c = isFilled ? full : { r: Math.round(full.r * 0.15), g: Math.round(full.g * 0.15), b: Math.round(full.b * 0.15) };
      for (let dy = 0; dy < el.height; dy++) {
        const px = el.x + dx;
        const py = el.y + dy;
        if (px >= 0 && px < 64 && py >= 0 && py < 32) {
          pixels.push({ x: px, y: py, r: c.r, g: c.g, b: c.b });
        }
      }
    }
  }

  return pixels;
}

// Elements are drawn bottom-to-top and opaque, so a pixel fully covered by
// something stacked above it is never actually visible on the device. The
// naive per-element concat sent every layer's pixels regardless — for a
// full-screen background rect under text/icons that's 2000+ redundant
// entries the ESP32 has no use for. Flattening to one entry per (x,y) here
// (later element wins, matching draw order) culls those before they ever
// hit the wire, cutting payload size and pointless overdraw on the device.
function compositeFramePixels(elements) {
  const map = new Map();
  for (const el of elements) {
    for (const p of getElementPixels(el)) map.set(p.y * 64 + p.x, p);
  }
  return [...map.values()];
}

// ESP32 endpoint - returns compact pixel data for current screen
// Format: JSON with pixels array and animation info
app.get('/api/esp/pixels', async (req, res) => {
  const data = loadData();
  const screen = data.activeScreenId ? data.screens.find(s => s.id === data.activeScreenId) : null;
  if (!screen || await isScreenHidden(screen)) {
    return res.json({ id: null, name: null, isAnimated: false, frameDelay: 200, frameCount: 0, frames: [] });
  }

  const frames = await Promise.all(screen.frames.map(async frameElements => {
    const resolved = await resolveFrameElements(frameElements);
    return compositeFramePixels(resolved);
  }));

  res.json({
    id: screen.id,
    name: screen.name,
    isAnimated: screen.isAnimated,
    frameDelay: screen.frameDelay,
    frameCount: frames.length,
    frames: frames
  });
});

// ESP32 endpoint - returns raw binary pixel data (more efficient)
// Format: [frameCount:1][frameDelay:2][frame0PixelCount:2][x:1,y:1,r:1,g:1,b:1]...[frame1...]
app.get('/api/esp/binary', async (req, res) => {
  const data = loadData();
  if (!data.activeScreenId) {
    return res.send(Buffer.from([0]));
  }

  const screen = data.screens.find(s => s.id === data.activeScreenId);
  if (!screen || await isScreenHidden(screen)) {
    return res.send(Buffer.from([0]));
  }

  const frames = await Promise.all(screen.frames.map(async frameElements => {
    const resolved = await resolveFrameElements(frameElements);
    return compositeFramePixels(resolved);
  }));

  // Calculate buffer size
  let size = 3; // frameCount(1) + frameDelay(2)
  frames.forEach(f => {
    size += 2; // pixel count per frame
    size += f.length * 5; // x,y,r,g,b per pixel
  });
  
  const buffer = Buffer.alloc(size);
  let offset = 0;
  
  buffer.writeUInt8(frames.length, offset++);
  buffer.writeUInt16LE(screen.frameDelay || 200, offset);
  offset += 2;
  
  frames.forEach(pixels => {
    buffer.writeUInt16LE(pixels.length, offset);
    offset += 2;
    pixels.forEach(p => {
      buffer.writeUInt8(p.x, offset++);
      buffer.writeUInt8(p.y, offset++);
      buffer.writeUInt8(p.r, offset++);
      buffer.writeUInt8(p.g, offset++);
      buffer.writeUInt8(p.b, offset++);
    });
  });
  
  res.set('Content-Type', 'application/octet-stream');
  res.send(buffer);
});

// ESP32 endpoint - simple status check
app.get('/api/esp/status', async (req, res) => {
  const data = loadData();
  const screen = data.activeScreenId ? data.screens.find(s => s.id === data.activeScreenId) : null;
  const hidden = screen ? await isScreenHidden(screen) : false;
  res.json({
    hasActiveScreen: !!screen && !hidden,
    activeScreenId: data.activeScreenId,
    activeScreenName: screen?.name,
    activeScreenHidden: hidden,
    screenCount: data.screens.length,
    timestamp: Date.now()
  });
});

// List all screens for ESP32 (to allow switching)
app.get('/api/esp/screens', (req, res) => {
  const data = loadData();
  res.json({
    screens: data.screens.map(s => ({ id: s.id, name: s.name })),
    activeScreenId: data.activeScreenId
  });
});

// ESP32 can set active screen
app.post('/api/esp/active/:id', (req, res) => {
  const data = loadData();
  const screen = data.screens.find(s => s.id === req.params.id);
  if (!screen) {
    return res.status(404).json({ error: 'Screen not found' });
  }
  data.activeScreenId = req.params.id;
  saveData(data);
  res.json({ success: true, activeScreenId: data.activeScreenId });
});

// Serve index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LED Matrix Server running on http://0.0.0.0:${PORT}`);
  console.log(`ESP32 API endpoints:`);
  console.log(`  GET  /api/esp/pixels  - JSON pixel data`);
  console.log(`  GET  /api/esp/binary  - Binary pixel data`);
  console.log(`  GET  /api/esp/status  - Server status`);
  console.log(`  GET  /api/esp/screens - List screens`);
  console.log(`  POST /api/esp/active/:id - Set active screen`);
  restartCycleTimer();
});
