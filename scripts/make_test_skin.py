#!/usr/bin/env python3
"""Generates skins/TestSkin.wmz: a tiny original skin used to exercise the renderer
(clipping shape, mapped button group, slider, text, effects, subview slide, JScript)
without needing any third-party skin. Usage: python3 scripts/make_test_skin.py"""
import struct, zipfile, pathlib

W, H = 320, 140
MAGENTA = (255, 0, 255)

def bmp(w, h, px):  # px(x, y) -> (r, g, b)
    row = (w * 3 + 3) & ~3
    data = bytearray()
    for y in range(h - 1, -1, -1):
        r = bytearray()
        for x in range(w):
            c = px(x, y)
            r += bytes((c[2], c[1], c[0]))
        data += r + b"\0" * (row - w * 3)
    hdr = b"BM" + struct.pack("<IHHI", 54 + len(data), 0, 0, 54)
    hdr += struct.pack("<IiiHHIIiiII", 40, w, h, 1, 24, 0, len(data), 2835, 2835, 0, 0)
    return hdr + data

def in_round(x, y, w, h, r):
    cx = min(max(x, r), w - 1 - r); cy = min(max(y, r), h - 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

def body(x, y):
    if not in_round(x, y, W, H, 22): return MAGENTA
    if x < 3 or y < 3 or x >= W - 3 or y >= H - 3: return (90, 200, 110)
    return (20, 48 + y // 4, 28)

BTN = [("prev", 20, (255, 0, 0)), ("play", 70, (0, 255, 0)), ("stop", 120, (0, 0, 255)), ("next", 170, (255, 255, 0))]
BX, BY, BW, BH = 20, 70, 200, 36

def btn_img(kind):
    def px(x, y):
        for i, (_, bx, _c) in enumerate(BTN):
            if bx - 20 <= x < bx - 20 + 44 and 4 <= y < 32:
                f = {"n": (40, 110, 60), "h": (90, 190, 110), "d": (160, 255, 170)}[kind]
                return f
        return MAGENTA
    return px
def mapping(x, y):
    for _, bx, c in BTN:
        if bx - 20 <= x < bx - 20 + 44 and 4 <= y < 32: return c
    return (0, 0, 0)

def slider_track(x, y):
    return (50, 90, 60) if 8 <= y < 12 else MAGENTA
def slider_fill(x, y):
    return (120, 255, 150) if 8 <= y < 12 else MAGENTA
def thumb(x, y):
    return (230, 255, 235) if 2 <= x < 10 else MAGENTA
def panel(x, y):
    return (30, 70, 40) if x < 90 and y < 100 else MAGENTA

wms = f'''<?xml version="1.0"?>
<THEME title="Test Skin" author="retro-mp3-yt-music">
 <VIEW width="{W}" height="{H}" backgroundImage="body.bmp" clippingColor="#FF00FF" scriptFile="test.js" onload="jscript:init();">
  <TEXT id="title" left="20" top="14" width="280" height="18" fontFace="Arial" fontSize="11" foregroundColor="#c8ffd2"
        value="wmpprop:player.currentMedia.name" scrolling="true" onclick="jscript:player.controls.pause();"/>
  <TEXT id="time" left="20" top="34" width="120" height="16" fontSize="9" foregroundColor="#7fbf8a"
        value="wmpprop:player.controls.currentPositionString"/>
  <SLIDER id="seek" left="20" top="52" width="280" height="14" image="track.bmp" foregroundImage="fill.bmp" thumbImage="thumb.bmp"
          transparencyColor="#FF00FF" min="0" max="wmpprop:player.currentMedia.duration" value="wmpprop:player.controls.currentPosition"/>
  <BUTTONGROUP id="transport" left="20" top="{BY}" image="btn_n.bmp" hoverImage="btn_h.bmp" downImage="btn_d.bmp" mappingImage="map.bmp" transparencyColor="#FF00FF">
   <BUTTONELEMENT id="prevBtn" mappingColor="#FF0000" upToolTip="Previous" onclick="jscript:player.controls.previous();"/>
   <BUTTONELEMENT id="playBtn" mappingColor="#00FF00" upToolTip="Play / pause" onclick="jscript:togglePlay();"/>
   <BUTTONELEMENT id="stopBtn" mappingColor="#0000FF" upToolTip="Stop" onclick="jscript:player.controls.stop();"/>
   <BUTTONELEMENT id="nextBtn" mappingColor="#FFFF00" upToolTip="Next" onclick="jscript:player.controls.next();"/>
  </BUTTONGROUP>
  <SLIDER id="vol" left="240" top="76" width="60" height="14" image="track.bmp" foregroundImage="fill.bmp" thumbImage="thumb.bmp"
          transparencyColor="#FF00FF" min="0" max="100" value="wmpprop:player.settings.volume"/>
  <EFFECTS id="viz" left="20" top="110" width="200" height="22" type="bars" foregroundColor="#5dff8a"/>
  <BUTTONELEMENT id="more" left="270" top="112" image="thumb.bmp" hoverImage="thumb.bmp" downImage="thumb.bmp" transparencyColor="#FF00FF" upToolTip="Toggle panel" onclick="jscript:togglePanel();"/>
  <SUBVIEW id="side" left="{W-90}" top="20" width="90" height="100" backgroundImage="panel.bmp" transparencyColor="#FF00FF" visible="false" zIndex="5">
   <TEXT id="sideText" left="6" top="6" width="78" height="60" fontSize="8" foregroundColor="#c8ffd2" wordWrap="true" value="wmpprop:player.currentMedia.getItemInfo('Author')"/>
  </SUBVIEW>
 </VIEW>
</THEME>
'''
js = '''var panelOpen = false;
function init() { view.alwaysOnTop = false; }
function togglePlay() {
  if (player.playState == 3) player.controls.pause(); else player.controls.play();
}
function togglePanel() {
  panelOpen = !panelOpen;
  if (panelOpen) { side.visible = true; side.left = 340; side.moveTo(230, 20, 250); }
  else { side.moveTo(340, 20, 250); setTimeout("side.visible = false;", 300); }
}
'''

out = pathlib.Path(__file__).resolve().parent.parent / "skins" / "TestSkin.wmz"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("test.wms", wms)
    z.writestr("test.js", js)
    z.writestr("body.bmp", bmp(W, H, body))
    z.writestr("btn_n.bmp", bmp(BW, BH, btn_img("n")))
    z.writestr("btn_h.bmp", bmp(BW, BH, btn_img("h")))
    z.writestr("btn_d.bmp", bmp(BW, BH, btn_img("d")))
    z.writestr("map.bmp", bmp(BW, BH, mapping))
    z.writestr("track.bmp", bmp(280, 14, slider_track))
    z.writestr("fill.bmp", bmp(280, 14, slider_fill))
    z.writestr("thumb.bmp", bmp(12, 14, thumb))
    z.writestr("panel.bmp", bmp(90, 100, panel))
print("wrote", out)
