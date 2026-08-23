const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'screens.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

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

// Settings (e.g. connected display URL) persistence
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading settings:', e);
  }
  return { deviceUrl: '', lastPush: null };
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// Build the same pixel payload shape as GET /api/esp/pixels for a given screen
function buildPixelPayload(screen) {
  const frames = screen.frames.map(frameElements => {
    const allPixels = [];
    frameElements.forEach(el => {
      allPixels.push(...getElementPixels(el));
    });
    return allPixels;
  });
  return {
    id: screen.id,
    name: screen.name,
    isAnimated: screen.isAnimated,
    frameDelay: screen.frameDelay,
    frameCount: frames.length,
    frames: frames
  };
}

// Push the active screen's pixel data to the configured display, if any.
// Best-effort: failures are recorded but never block the caller.
async function pushActiveScreenToDevice() {
  const settings = loadSettings();
  if (!settings.deviceUrl) return;

  const data = loadData();
  const screen = data.activeScreenId ? data.screens.find(s => s.id === data.activeScreenId) : null;
  if (!screen) return;

  const url = settings.deviceUrl.replace(/\/+$/, '') + '/api/pixels';
  const result = { timestamp: Date.now(), url, success: false, error: null };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPixelPayload(screen)),
      signal: controller.signal
    });
    clearTimeout(timeout);
    result.success = res.ok;
    if (!res.ok) result.error = `HTTP ${res.status}`;
  } catch (e) {
    result.error = e.name === 'AbortError' ? 'Timed out' : e.message;
  }

  settings.lastPush = result;
  saveSettings(settings);
  return result;
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
    updatedAt: s.updatedAt
  }));
  res.json({ screens, activeScreenId: data.activeScreenId });
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
app.put('/api/screens/:id', async (req, res) => {
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
    updatedAt: new Date().toISOString()
  };
  saveData(data);
  let push;
  if (data.activeScreenId === req.params.id) {
    push = await pushActiveScreenToDevice();
  }
  res.json({ ...data.screens[index], push });
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
app.post('/api/active/:id', async (req, res) => {
  const data = loadData();
  const screen = data.screens.find(s => s.id === req.params.id);
  if (!screen) {
    return res.status(404).json({ error: 'Screen not found' });
  }
  data.activeScreenId = req.params.id;
  saveData(data);
  const push = await pushActiveScreenToDevice();
  res.json({ activeScreenId: data.activeScreenId, push });
});

// Get active screen ID
app.get('/api/active', (req, res) => {
  const data = loadData();
  res.json({ activeScreenId: data.activeScreenId });
});

// ============ Display Settings ============

// Get connected display settings (device URL + last push result)
app.get('/api/settings', (req, res) => {
  res.json(loadSettings());
});

// Update connected display settings
app.put('/api/settings', (req, res) => {
  const settings = loadSettings();
  settings.deviceUrl = (req.body.deviceUrl || '').trim();
  saveSettings(settings);
  res.json(settings);
});

// Manually push the active screen to the configured display now
app.post('/api/push', async (req, res) => {
  const settings = loadSettings();
  if (!settings.deviceUrl) {
    return res.status(400).json({ error: 'No display URL configured' });
  }
  const push = await pushActiveScreenToDevice();
  res.json({ push });
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

// Convert elements to pixel array
function getTextPixels(text, x, y, fontName, color) {
  const font = FONTS[fontName] || FONTS.small;
  const pixels = [];
  let cursorX = x;
  
  for (const char of text.toUpperCase()) {
    const charData = font.chars[char] || font.chars[' '];
    if (charData) {
      for (let row = 0; row < font.height; row++) {
        for (let col = 0; col < font.width; col++) {
          if ((charData[row] >> (font.width - 1 - col)) & 1) {
            const px = cursorX + col;
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
    return getTextPixels(el.text, el.x, el.y, el.fontSize, color);
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
  
  return pixels;
}

// ESP32 endpoint - returns compact pixel data for current screen
// Format: JSON with pixels array and animation info
app.get('/api/esp/pixels', (req, res) => {
  const data = loadData();
  if (!data.activeScreenId) {
    return res.json({ pixels: [], frameCount: 0 });
  }
  
  const screen = data.screens.find(s => s.id === data.activeScreenId);
  if (!screen) {
    return res.json({ pixels: [], frameCount: 0 });
  }
  
  const frames = screen.frames.map(frameElements => {
    const allPixels = [];
    frameElements.forEach(el => {
      allPixels.push(...getElementPixels(el));
    });
    return allPixels;
  });
  
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
app.get('/api/esp/binary', (req, res) => {
  const data = loadData();
  if (!data.activeScreenId) {
    return res.send(Buffer.from([0]));
  }
  
  const screen = data.screens.find(s => s.id === data.activeScreenId);
  if (!screen) {
    return res.send(Buffer.from([0]));
  }
  
  const frames = screen.frames.map(frameElements => {
    const allPixels = [];
    frameElements.forEach(el => {
      allPixels.push(...getElementPixels(el));
    });
    return allPixels;
  });
  
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
app.get('/api/esp/status', (req, res) => {
  const data = loadData();
  const screen = data.activeScreenId ? data.screens.find(s => s.id === data.activeScreenId) : null;
  res.json({
    hasActiveScreen: !!screen,
    activeScreenId: data.activeScreenId,
    activeScreenName: screen?.name,
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
app.post('/api/esp/active/:id', async (req, res) => {
  const data = loadData();
  const screen = data.screens.find(s => s.id === req.params.id);
  if (!screen) {
    return res.status(404).json({ error: 'Screen not found' });
  }
  data.activeScreenId = req.params.id;
  saveData(data);
  const push = await pushActiveScreenToDevice();
  res.json({ success: true, activeScreenId: data.activeScreenId, push });
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
});
