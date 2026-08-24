/* =====================================================================
   Sunset Valley — procedural Three.js recreation
   Exposes window.ValleyScene.mount(container, options)
   ===================================================================== */
(function (global) {
  'use strict';
  var T = global.THREE;
  if (!T) { console.error('[ValleyScene] three.js not found'); return; }

  /* ---------------------------------------------------------------- utils */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var clamp01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  function smoothstep(e0, e1, x) { var t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); }
  function easeInOut(t) { return t * t * (3 - 2 * t); }

  /* value noise + fbm (deterministic, no textures) */
  function hash2(x, y) {
    var n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return n - Math.floor(n);
  }
  function vnoise(x, y) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }
  function fbm(x, y, oct) {
    oct = oct || 4;
    var s = 0, a = 0.5, f = 1;
    for (var i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f); f *= 2.03; a *= 0.5; }
    return s;
  }

  /* colour helper: hex -> THREE.Color (sRGB aware) */
  function C(hex) { return new T.Color(hex); }
  function mixC(out, a, b, t) { out.copy(a).lerp(b, clamp01(t)); return out; }

  /* ------------------------------------------------------- world constants */
  var W = {
    // river centreline: x offset as a function of z
    riverX: function (z) {
      return 96 + z * 0.052 + Math.sin((z + 400) * 0.0032) * 46 + Math.sin((z - 90) * 0.0009) * 30;
    },
    riverHalf: function (z) { return 34 + smoothstep(-1200, 200, z) * 16; },
    // promenade centreline
    promX: function (z) {
      var rx = 96 + z * 0.052 + Math.sin((z + 400) * 0.0032) * 46 + Math.sin((z - 90) * 0.0009) * 30;
      return rx - 74 - Math.sin((z + 250) * 0.0011) * 7;
    },
    promHalf: 13.5,
    camZ: 300, camX: 26
  };

  /* Terrain height field — art-directed to match the reference framing. */
  function terrainH(x, z) {
    var h = 0;

    // ---- left hillside (steep, terraced, camera sits on its shoulder)
    var L = clamp01((-x - 18) / 300);
    h += Math.pow(L, 1.35) * 168;

    // ---- the long shoulder the camera stands on: gentle at the top so the
    //      near orchard stays inside the frame, steepening into the valley
    var fg = clamp01((z + 60) / 392);
    fg = fg * fg * (3 - 2 * fg);          // flat at the camera, steep mid, flat in the valley
    h += fg * 118;

    // ---- right hillside / forested slope
    var R = clamp01((x - 215) / 400);
    h += Math.pow(R, 1.45) * 132;

    // ---- big hazy mountain, far right
    var mz = clamp01((-z - 520) / 900);
    var mx = clamp01((x - 360) / 900);
    h += Math.pow(mx, 1.15) * mz * 520;

    // ---- distant plain: flatten the centre so the sun sets over open ground
    var plain = smoothstep(-430, -1250, z) * clamp01(1.0 - Math.abs(x) / 1150);
    h *= (1.0 - plain * 0.96);

    // ---- organic noise, scaled by how steep we already are
    var slope = clamp01((L + R + fg) * 0.9);
    h += (fbm(x * 0.0042 + 11, z * 0.0042 - 7, 5) - 0.5) * (10 + slope * 30);
    h += (fbm(x * 0.019 + 3, z * 0.019 + 5, 3) - 0.5) * (2.0 + slope * 6);

    // ---- river channel carve
    var rx = W.riverX(z), rh = W.riverHalf(z);
    var d = Math.abs(x - rx);
    var fade = clamp01((-z - 60) / 140);
    var flat = 1.0 - smoothstep(rh * 2.6, rh * 8.0, d);
    h = lerp(h, lerp(h, 1.2, 0.75), flat * 0.72 * fade);      // flood plain
    var bank = 1.0 - smoothstep(rh * 0.88, rh * 2.6, d);
    h = lerp(h, -9.0, bank * bank * 0.99 * fade);             // channel

    return h;
  }

  /* ---------------------------------------------------- time-of-day model */
  var SUNRISE = 6.15, SUNSET = 20.55, MAXELEV = 58 * Math.PI / 180;

  function sunState(hours) {
    var h = ((hours % 24) + 24) % 24;
    var dayLen = SUNSET - SUNRISE, u, elev, az, isDay;
    if (h >= SUNRISE && h <= SUNSET) {
      isDay = true;
      u = (h - SUNRISE) / dayLen;
    } else {
      isDay = false;
      var nh = h < SUNRISE ? h + 24 : h;              // 20.55 .. 30.15
      u = (nh - SUNSET) / (24 - dayLen);              // 0..1 across the night
      u = 1 + u;                                      // 1..2
    }
    if (isDay) {
      elev = Math.sin(u * Math.PI) * MAXELEV;
      az = Math.PI * (1 - u);                         // PI at sunrise (behind) -> 0 at sunset (ahead)
    } else {
      var n = u - 1;                                  // 0..1 after sunset
      elev = -Math.sin(n * Math.PI) * (MAXELEV * 0.72);
      az = -Math.PI * n;                              // continues past west, under, to east
    }
    // direction: az measured from forward(-Z) rotating toward -X (left)
    var ce = Math.cos(elev), se = Math.sin(elev);
    var dir = new T.Vector3(-Math.sin(az) * ce, se, -Math.cos(az) * ce).normalize();
    return { hours: h, elev: elev, elevDeg: elev * 180 / Math.PI, az: az, dir: dir, u: u, isDay: isDay };
  }

  /* Palette keyed on sun elevation (degrees). Stops are hand-tuned so that
     elev ~ +3.5deg reproduces the reference frame. */
  var PAL = [
    /* deg,  zenith,   mid,      horizon,  haze,     sunGlow,  sunDisc,  lightCol, lightI, ambCol,   ambI, fogD    */
    [-18, '#040711', '#060b18', '#080e1e', '#0a1426', '#0e1a30', '#dfe8ff', '#9fb0dc', 0.34, '#141f38', 0.34, 0.00042],
    [-9, '#060f22', '#0e1730', '#18203c', '#252c4a', '#3b3552', '#ffe9c8', '#a2b2dc', 0.38, '#1b2846', 0.38, 0.00048],
    [-3.5, '#132443', '#2c3352', '#514063', '#7d565c', '#a85f42', '#ffd9a0', '#c8865e', 0.52, '#2a3550', 0.58, 0.00056],
    [0.4, '#5a7a9a', '#c9ae94', '#e0aa74', '#f0bd83', '#f2913f', '#fff0c0', '#f5975a', 1.45, '#6a7890', 1.20, 0.00042],
    [3.6, '#8ba4b8', '#dcc3a2', '#eeb87e', '#ffcf90', '#f5a95e', '#fffdf2', '#ffb673', 2.20, '#7e8ea0', 1.34, 0.00035],
    [9, '#89a6c2', '#d7ccb6', '#eccaa0', '#f7d9ae', '#f7cd9a', '#fffdf6', '#ffd0a8', 2.55, '#8fa0b2', 1.40, 0.00032],
    [20, '#6f99cd', '#c6d2d8', '#c9d3d8', '#dde2e2', '#ffe8c4', '#ffffff', '#ffe9cf', 2.80, '#9aabbf', 1.22, 0.00023],
    [38, '#4a82c7', '#b9cbdc', '#c4d5e4', '#d8e2ea', '#fff2dc', '#ffffff', '#fff3e6', 3.00, '#a6bdd6', 1.30, 0.00018],
    [60, '#3c74c1', '#b0c8de', '#bcd2e4', '#d2dfeb', '#fff7ec', '#ffffff', '#fff8ef', 3.10, '#b0c6dc', 1.36, 0.00016]
  ].map(function (r) {
    return {
      deg: r[0], zenith: C(r[1]), mid: C(r[2]), horizon: C(r[3]), haze: C(r[4]), glow: C(r[5]),
      disc: C(r[6]), light: C(r[7]), lightI: r[8], amb: C(r[9]), ambI: r[10], fogD: r[11]
    };
  });

  var _tmpA = new T.Color(), _tmpB = new T.Color();
  function palAt(deg) {
    var i = 0;
    while (i < PAL.length - 2 && deg > PAL[i + 1].deg) i++;
    var a = PAL[i], b = PAL[i + 1];
    var t = easeInOut(clamp01((deg - a.deg) / (b.deg - a.deg)));
    return {
      zenith: mixC(new T.Color(), a.zenith, b.zenith, t),
      mid: mixC(new T.Color(), a.mid, b.mid, t),
      horizon: mixC(new T.Color(), a.horizon, b.horizon, t),
      haze: mixC(new T.Color(), a.haze, b.haze, t),
      glow: mixC(new T.Color(), a.glow, b.glow, t),
      disc: mixC(new T.Color(), a.disc, b.disc, t),
      light: mixC(new T.Color(), a.light, b.light, t),
      amb: mixC(new T.Color(), a.amb, b.amb, t),
      lightI: lerp(a.lightI, b.lightI, t),
      ambI: lerp(a.ambI, b.ambI, t),
      fogD: lerp(a.fogD, b.fogD, t)
    };
  }

  global.ValleyScene = global.ValleyScene || {};
  global.ValleyScene._core = {
    mulberry32: mulberry32, clamp: clamp, clamp01: clamp01, lerp: lerp,
    smoothstep: smoothstep, fbm: fbm, vnoise: vnoise, C: C,
    W: W, terrainH: terrainH, sunState: sunState, palAt: palAt,
    SUNRISE: SUNRISE, SUNSET: SUNSET
  };
})(window);

/* =====================================================================
   Part B — sky dome, water, terrain
   ===================================================================== */
(function (global) {
  'use strict';
  var T = global.THREE, K = global.ValleyScene._core;
  var W = K.W, terrainH = K.terrainH;

  /* ------------------------------------------------------------- sky dome */
  var SKY_VS = [
    'varying vec3 vDir;',
    'void main(){',
    '  vDir = (modelMatrix * vec4(position,1.0)).xyz - cameraPosition;',
    '  vec4 mv = modelViewMatrix * vec4(position,1.0);',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var SKY_FS = [
    'precision highp float;',
    'uniform vec3 uSunDir, uMoonDir, uZenith, uMid, uHorizon, uHaze, uGlow, uDisc;',
    'uniform float uNight, uSunUp, uTime, uExposure;',
    'varying vec3 vDir;',
    'float h21(vec2 p){ p = fract(p*vec2(443.897,441.423)); p += dot(p, p.yx+19.19); return fract((p.x+p.y)*p.x); }',
    'void main(){',
    '  vec3 d = normalize(vDir);',
    '  float y = d.y;',
    '  vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.115, y));',
    '  col = mix(col, uZenith, smoothstep(0.030, 0.34, y));',
    // dense haze band hugging the horizon
    '  float band = exp(-abs(y)*30.0);',
    '  col = mix(col, uHaze, band*0.80);',
    // below-horizon ground haze (distant terrain fades into it)
    '  col = mix(col, uHaze*0.86, smoothstep(0.0,-0.10,y));',
    // sun scattering halo
    '  float cd = max(dot(d, uSunDir), 0.0);',
    '  float glow = pow(cd, 7.0)*0.10 + pow(cd, 70.0)*0.38 + pow(cd, 900.0)*1.5;',
    '  col += uGlow * glow * (0.25 + 0.75*uSunUp);',
    // stars
    '  if (uNight > 0.001) {',
    '    vec3 sd = d * 210.0;',
    '    vec2 g2 = sd.xz + sd.y*0.41;',
    '    vec2 cell = floor(g2); vec2 fr = fract(g2);',
    '    float r = h21(cell);',
    '    vec2 sp = vec2(h21(cell + 7.13), h21(cell + 3.37));',
    '    float dd = length(fr - sp);',
    '    float s = smoothstep(0.972, 1.0, r) * exp(-pow(dd/0.085, 2.0));',
    '    float tw = 0.60 + 0.40*sin(uTime*2.1 + r*90.0);',
    '    col += vec3(0.86,0.90,1.0) * s * tw * uNight * clamp(y*2.2,0.0,1.0) * 2.6;',
    '  }',
    // moon
    '  float md = max(dot(d, uMoonDir), 0.0);',
    '  float mAng = acos(clamp(md,-1.0,1.0));',
    '  float moon = 1.0 - smoothstep(0.0135, 0.0165, mAng);',
    '  col += vec3(1.0,0.98,0.92) * moon * uNight * 0.85;',
    '  col += vec3(0.55,0.64,0.92) * exp(-pow(mAng/0.075,2.0)) * uNight * 0.12;',
    '  col += vec3(0.45,0.54,0.80) * pow(md, 600.0) * uNight * 0.35;',
    // sun disc (drawn last, hot core for the bloom pass to catch)
    '  float ang = acos(clamp(cd,-1.0,1.0));',
    '  float disc = 1.0 - smoothstep(0.0112, 0.0134, ang);',
    '  float horizonDim = smoothstep(-0.055, 0.02, uSunDir.y);',
    '  col += uDisc * disc * horizonDim * 5.5;',
    '  gl_FragColor = vec4(col * uExposure, 1.0);',
    '}'
  ].join('\n');

  function makeSky() {
    var geo = new T.SphereGeometry(7000, 48, 32);
    var uni = {
      uSunDir: { value: new T.Vector3(0, 0.1, -1) },
      uMoonDir: { value: new T.Vector3(0, 0.4, 1) },
      uZenith: { value: new T.Color('#7d9cb8') },
      uMid: { value: new T.Color('#dcc0a0') },
      uHorizon: { value: new T.Color('#e8a866') },
      uHaze: { value: new T.Color('#ffc98a') },
      uGlow: { value: new T.Color('#ffb063') },
      uDisc: { value: new T.Color('#fffdf2') },
      uNight: { value: 0 }, uSunUp: { value: 1 }, uTime: { value: 0 }, uExposure: { value: 1 }
    };
    var mat = new T.ShaderMaterial({
      uniforms: uni, vertexShader: SKY_VS, fragmentShader: SKY_FS,
      side: T.BackSide, depthWrite: false, depthTest: false, fog: false
    });
    var m = new T.Mesh(geo, mat);
    m.renderOrder = -1000;
    m.frustumCulled = false;
    m.userData.uniforms = uni;
    return m;
  }

  /* --------------------------------------------------------------- water */
  var WATER_VS = [
    'varying vec3 vW; varying vec2 vUv2;',
    'void main(){',
    '  vec4 wp = modelMatrix * vec4(position,1.0);',
    '  vW = wp.xyz; vUv2 = uv;',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}'
  ].join('\n');

  var WATER_FS = [
    'precision highp float;',
    'uniform vec3 uSunDir, uZenith, uMid, uHorizon, uHaze, uGlow, uDisc, uDeep, uShallow, uFogCol;',
    'uniform float uTime, uNight, uSunUp, uFogD;',
    'varying vec3 vW; varying vec2 vUv2;',
    'float hs(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }',
    'float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);',
    '  return mix(mix(hs(i),hs(i+vec2(1,0)),f.x), mix(hs(i+vec2(0,1)),hs(i+vec2(1,1)),f.x), f.y); }',
    'vec3 skyAt(vec3 d){',
    '  vec3 c = mix(uHorizon, uMid, smoothstep(0.0, 0.115, d.y));',
    '  c = mix(c, uZenith, smoothstep(0.030, 0.34, d.y));',
    '  c = mix(c, uHaze, exp(-abs(d.y)*30.0)*0.80);',
    '  float cd = max(dot(d,uSunDir),0.0);',
    '  c += uGlow * (pow(cd,7.0)*0.10 + pow(cd,70.0)*0.38) * (0.25+0.75*uSunUp);',
    '  return c;',
    '}',
    'void main(){',
    '  vec3 V = normalize(cameraPosition - vW);',
    // layered ripples -> normal
    '  vec2 p = vW.xz;',
    '  float n1 = vn(p*0.085 + vec2(uTime*0.35, uTime*0.11));',
    '  float n2 = vn(p*0.031 - vec2(uTime*0.16, uTime*0.05));',
    '  float n3 = vn(p*0.24  + vec2(-uTime*0.55, uTime*0.31));',
    '  float e = 0.55;',
    '  float hx = (vn((p+vec2(e,0.0))*0.085 + vec2(uTime*0.35,uTime*0.11)) - n1)/e;',
    '  float hz = (vn((p+vec2(0.0,e))*0.085 + vec2(uTime*0.35,uTime*0.11)) - n1)/e;',
    '  float gx = (vn((p+vec2(e,0.0))*0.24 + vec2(-uTime*0.55,uTime*0.31)) - n3)/e;',
    '  float gz = (vn((p+vec2(0.0,e))*0.24 + vec2(-uTime*0.55,uTime*0.31)) - n3)/e;',
    '  vec3 N = normalize(vec3(-(hx*2.3 + gx*0.85), 1.0, -(hz*2.3 + gz*0.85)));',
    '  vec3 Rv = reflect(-V, N);',
    '  vec3 R = Rv; R.y = abs(R.y)*0.55 + 0.012;',
    '  vec3 refl = skyAt(normalize(R));',
    '  float fres = pow(1.0 - max(dot(V,N),0.0), 5.0);',
    '  fres = mix(0.015, 0.20, fres);',
    '  vec3 body = mix(uDeep, uShallow, clamp(n2*1.3,0.0,1.0));',
    '  vec3 col = mix(body, refl, clamp(fres,0.0,1.0));',
    // sun glitter: broad vertical column
    '  float sunVis = smoothstep(-0.05, 0.06, uSunDir.y);',
    '  float sd = max(dot(normalize(Rv), uSunDir), 0.0);',
    '  float sAng = acos(clamp(sd, -1.0, 1.0));',
    '  float glint = exp(-pow(sAng/0.030, 2.0));',
    '  float halo  = exp(-pow(sAng/0.105, 2.0));',
    '  float sparkle = 0.45 + 0.55*smoothstep(0.30,0.92, vn(p*1.35 + vec2(uTime*0.9, -uTime*0.4)));',
    '  col += refl * 0.055;',
    '  col += uDisc * glint * sparkle * 9.5 * sunVis;',
    '  col += uGlow * halo * 0.75 * sunVis;',
    // fog
    '  float dist = length(cameraPosition - vW);',
    '  float f = 1.0 - exp(-pow(dist*uFogD, 2.0));',
    '  col = mix(col, uFogCol, clamp(f,0.0,1.0));',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /* Build the river as a ribbon following W.riverX */
  function makeRiver() {
    // Cover the full carved channel: from behind the camera (pz ≈ 300) to
    // the terrain's far edge (the plane is shifted to z ∈ [-2940, 460]).
    // Ending short leaves a dry riverbed in the foreground or the horizon.
    var zStart = 320, zEnd = -2930, steps = 280, cross = 12;
    var pos = [], uvs = [], idx = [];
    for (var i = 0; i <= steps; i++) {
      var tz = i / steps;
      var z = K.lerp(zStart, zEnd, tz);
      var cx = W.riverX(z), hw = W.riverHalf(z) * 1.06;
      for (var j = 0; j <= cross; j++) {
        var tx = j / cross;
        pos.push(cx + (tx - 0.5) * 2 * hw, -2.2, z);
        uvs.push(tx, tz);
      }
    }
    for (i = 0; i < steps; i++) {
      for (j = 0; j < cross; j++) {
        var a = i * (cross + 1) + j, b = a + 1, c = a + cross + 1, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();

    var uni = {
      uSunDir: { value: new T.Vector3(0, 0.1, -1) },
      uZenith: { value: new T.Color('#7d9cb8') }, uMid: { value: new T.Color('#dcc0a0') }, uHorizon: { value: new T.Color('#e8a866') },
      uHaze: { value: new T.Color('#ffc98a') }, uGlow: { value: new T.Color('#ffb063') },
      uDisc: { value: new T.Color('#fffdf2') },
      uDeep: { value: new T.Color('#16241f') }, uShallow: { value: new T.Color('#2c4438') },
      uFogCol: { value: new T.Color('#ffc98a') },
      uTime: { value: 0 }, uNight: { value: 0 }, uSunUp: { value: 1 }, uFogD: { value: 0.0008 }
    };
    var mat = new T.ShaderMaterial({ uniforms: uni, vertexShader: WATER_VS, fragmentShader: WATER_FS, fog: false, side: T.DoubleSide });
    var m = new T.Mesh(g, mat);
    m.userData.uniforms = uni;
    m.renderOrder = 2;
    return m;
  }

  /* -------------------------------------------------------------- terrain */
  var GRASS_HI = K.C('#8aa04e'), GRASS_LO = K.C('#4e6d38'), DRY = K.C('#9c9a5c');
  var ROCK = K.C('#6b6152'), SOIL = K.C('#4a3f30'), SAND = K.C('#9a8a63');

  function makeTerrain() {
    var SX = 2600, SZ = 3400, NX = 300, NZ = 340;
    var g = new T.PlaneGeometry(SX, SZ, NX, NZ);
    g.rotateX(-Math.PI / 2);
    var p = g.attributes.position, n = p.count;
    var colors = new Float32Array(n * 3);
    var c = new T.Color();
    // shift so the near edge sits behind the camera
    var zOff = -1500 + 260;
    for (var i = 0; i < n; i++) {
      var x = p.getX(i), z = p.getZ(i) + zOff;
      p.setZ(i, z);
      var y = terrainH(x, z);
      p.setY(i, y);
    }
    g.computeVertexNormals();
    // vertex colours from height / slope / moisture
    var nrm = g.attributes.normal;
    for (i = 0; i < n; i++) {
      var xx = p.getX(i), zz = p.getZ(i), yy = p.getY(i);
      var slope = 1.0 - nrm.getY(i);
      var moist = K.clamp01(1.0 - Math.abs(xx - W.riverX(zz)) / 240);
      var m = K.fbm(xx * 0.011 + 31, zz * 0.011 - 17, 3);
      c.copy(GRASS_LO).lerp(GRASS_HI, K.clamp01(m * 1.35 + 0.12 + moist * 0.22));
      c.lerp(DRY, K.clamp01((yy - 190) / 340) * 0.34);
      c.lerp(ROCK, K.clamp01((slope - 0.30) * 3.1));
      c.lerp(SOIL, K.clamp01((slope - 0.62) * 3.4) * 0.7);
      // riverbank sand
      var d = Math.abs(xx - W.riverX(zz)), hw = W.riverHalf(zz);
      c.lerp(SAND, K.clamp01(1.0 - K.smoothstep(hw * 1.0, hw * 1.55, d)) * 0.55);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new T.BufferAttribute(colors, 3));
    var mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0.0, flatShading: false });
    var mesh = new T.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    return mesh;
  }

  global.ValleyScene._world = { makeSky: makeSky, makeRiver: makeRiver, makeTerrain: makeTerrain };
})(window);

/* =====================================================================
   Part C — geometry builder, architecture, promenade
   ===================================================================== */
(function (global) {
  'use strict';
  var T = global.THREE, K = global.ValleyScene._core;
  var W = K.W, terrainH = K.terrainH;

  /* ------------------------------------------------- merged mesh builder */
  function Builder() { this.pos = []; this.nor = []; this.col = []; this.idx = []; this.n = 0; }
  Builder.prototype.add = function (geo, mtx, color, jitter) {
    var g = geo.index ? geo : geo.toNonIndexed();
    var p = g.attributes.position, nr = g.attributes.normal;
    if (!nr) { g.computeVertexNormals(); nr = g.attributes.normal; }
    var nm = new T.Matrix3().getNormalMatrix(mtx);
    var v = new T.Vector3(), nn = new T.Vector3();
    var base = this.n, i;
    for (i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(mtx);
      nn.fromBufferAttribute(nr, i).applyMatrix3(nm).normalize();
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(nn.x, nn.y, nn.z);
      var j = jitter ? (Math.random() - 0.5) * jitter : 0;
      this.col.push(K.clamp01(color.r + j), K.clamp01(color.g + j), K.clamp01(color.b + j));
    }
    if (g.index) { var ix = g.index.array; for (i = 0; i < ix.length; i++) this.idx.push(base + ix[i]); }
    else { for (i = 0; i < p.count; i++) this.idx.push(base + i); }
    this.n += p.count;
    return this;
  };
  Builder.prototype.addRaw = function (verts, tris, color) {
    var base = this.n, i;
    for (i = 0; i < verts.length; i++) {
      var v = verts[i];
      this.pos.push(v[0], v[1], v[2]); this.nor.push(0, 1, 0);
      this.col.push(color.r, color.g, color.b);
    }
    for (i = 0; i < tris.length; i++) this.idx.push(base + tris[i]);
    this.n += verts.length;
    return this;
  };
  Builder.prototype.build = function (recomputeNormals) {
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    if (recomputeNormals) g.computeVertexNormals();
    return g;
  };
  Builder.prototype.empty = function () { return this.n === 0; };

  var M4 = function () { return new T.Matrix4(); };
  function trs(x, y, z, rx, ry, rz, sx, sy, sz) {
    var m = new T.Matrix4();
    m.compose(new T.Vector3(x, y, z),
      new T.Quaternion().setFromEuler(new T.Euler(rx || 0, ry || 0, rz || 0)),
      new T.Vector3(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz));
    return m;
  }

  /* --------------------------------------------- organic shell / vault ---
     Parametric barrel-vault with a rounded nose, planted roof and a glazed
     arch face — the signature building of the reference image.            */
  function shellSurface(opt) {
    var len = opt.len, w = opt.w, h = opt.h, US = 34, VS = 24;
    var bend = opt.bend || 0, taper = opt.taper === undefined ? 1 : opt.taper;
    function P(u, v) {
      // u: 0 = glazed face, 1 = buried tail
      var prof = Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * u)), 0.30);
      var nose = K.smoothstep(1.0, 0.72, u);            // rounded closing tail
      var wu = w * prof * K.lerp(1, taper, u) * K.lerp(1, 0.16, 1 - nose);
      var hu = h * prof * K.lerp(1, taper, u) * K.lerp(1, 0.22, 1 - nose);
      var th = v * Math.PI;
      var x = Math.cos(th) * wu;
      var y = Math.pow(Math.sin(th), 0.66) * hu;
      var z = -u * len + Math.sin(u * Math.PI) * bend;
      return new T.Vector3(x, y, z);
    }
    var pos = [], idx = [], uvs = [], u, v, i, j;
    for (i = 0; i <= US; i++) {
      u = i / US;
      for (j = 0; j <= VS; j++) {
        v = j / VS;
        var p = P(u, v);
        pos.push(p.x, p.y, p.z); uvs.push(v, u);
      }
    }
    for (i = 0; i < US; i++) for (j = 0; j < VS; j++) {
      var a = i * (VS + 1) + j, b = a + 1, c = a + VS + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx); g.computeVertexNormals();
    g.userData.P = P; g.userData.US = US; g.userData.VS = VS;
    return g;
  }

  var CREAM = K.C('#efe6d6'), CREAM2 = K.C('#e2d6c2'), ROOFG = K.C('#4e6b34'), ROOFG2 = K.C('#67833f');
  var GLASSC = K.C('#16211f'), FRAME = K.C('#d8ccb8'), WARM = K.C('#ffb85c');

  function addShell(bWhite, bGreen, bGlass, bWarm, opt) {
    var g = shellSurface(opt);
    var mtx = trs(opt.x, opt.y, opt.z, 0, opt.ry || 0, 0, 1, 1, 1);

    // white shell (slightly thickened by drawing double sided later)
    bWhite.add(g, mtx, CREAM, 0.012);

    // planted roof: same surface pushed out along its normal, trimmed to the crown
    var P = g.userData.P, US = 30, VS = 18;
    var pos = [], idx = [], cols = [];
    var v0 = 0.17, v1 = 0.83, u0 = 0.035, u1 = 0.985;
    for (var i = 0; i <= US; i++) {
      var u = K.lerp(u0, u1, i / US);
      for (var j = 0; j <= VS; j++) {
        var v = K.lerp(v0, v1, j / VS);
        var p = P(u, v);
        var pu = P(Math.min(u + 0.01, 1), v).sub(p);
        var pv = P(u, Math.min(v + 0.01, 1)).sub(p);
        var nrm = new T.Vector3().crossVectors(pv, pu).normalize();
        var bump = (K.fbm(p.x * 0.7 + 40, p.z * 0.7 + 12, 3) - 0.5) * 0.55;
        p.addScaledVector(nrm, 0.42 + bump);
        pos.push(p.x, p.y, p.z);
        var c = ROOFG.clone().lerp(ROOFG2, K.fbm(p.x * 0.5, p.z * 0.5, 2));
        cols.push(c.r, c.g, c.b);
      }
    }
    for (i = 0; i < US; i++) for (j = 0; j < VS; j++) {
      var a = i * (VS + 1) + j, b = a + 1, c2 = a + VS + 1, d = c2 + 1;
      idx.push(a, b, c2, b, d, c2);
    }
    var rg = new T.BufferGeometry();
    rg.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    rg.setAttribute('color', new T.Float32BufferAttribute(cols, 3));
    rg.setIndex(idx); rg.computeVertexNormals();
    // merge with per-vertex colours preserved
    (function () {
      var p2 = rg.attributes.position, n2 = rg.attributes.normal, c2a = rg.attributes.color;
      var nm = new T.Matrix3().getNormalMatrix(mtx);
      var vv = new T.Vector3(), nn = new T.Vector3(), base = bGreen.n;
      for (var q = 0; q < p2.count; q++) {
        vv.fromBufferAttribute(p2, q).applyMatrix4(mtx);
        nn.fromBufferAttribute(n2, q).applyMatrix3(nm).normalize();
        bGreen.pos.push(vv.x, vv.y, vv.z); bGreen.nor.push(nn.x, nn.y, nn.z);
        bGreen.col.push(c2a.getX(q), c2a.getY(q), c2a.getZ(q));
      }
      var ix = rg.index.array;
      for (q = 0; q < ix.length; q++) bGreen.idx.push(base + ix[q]);
      bGreen.n += p2.count;
    })();

    // glazed arch face at u = 0 : fan triangulation of the arch outline
    var faceV = [], faceI = [], uu = 0.028;
    var cx = 0, cz = -uu * opt.len;
    faceV.push([cx, 0.02, cz]);
    var NF = 26;
    for (i = 0; i <= NF; i++) {
      var p3 = P(uu, i / NF);
      faceV.push([p3.x * 0.965, p3.y * 0.965 + 0.02, p3.z]);
    }
    for (i = 1; i <= NF; i++) faceI.push(0, i, i + 1);
    var fg = new T.BufferGeometry();
    var fp = [];
    for (i = 0; i < faceV.length; i++) fp.push(faceV[i][0], faceV[i][1], faceV[i][2]);
    fg.setAttribute('position', new T.Float32BufferAttribute(fp, 3));
    fg.setIndex(faceI); fg.computeVertexNormals();
    bGlass.add(fg, mtx, GLASSC);
    // back wall so daylight never leaks down the vault
    bGlass.add(fg, trs(opt.x, opt.y, opt.z, 0, opt.ry || 0, 0, 0.99, 0.99, 1).multiply(trs(0, 0, -opt.len * 0.55)), K.C('#0d1412'));
    bWarm.add(fg, trs(opt.x, opt.y, opt.z, 0, opt.ry || 0, 0, 0.88, 0.88, 1).multiply(trs(0, 0, -1.15)), WARM);

    // mullions across the glazed face
    for (i = 1; i < 7; i++) {
      var t2 = i / 7, pa = P(uu, t2);
      var mu = trs(opt.x, opt.y, opt.z, 0, opt.ry || 0, 0);
      var bar = new T.BoxGeometry(0.22, pa.y * 0.88, 0.22);
      var bm = mu.clone().multiply(trs(pa.x * 0.88, pa.y * 0.44, pa.z + 0.1));
      bWhite.add(bar, bm, FRAME);
    }
    // thick white rim around the opening
    var rimN = 30;
    for (i = 0; i < rimN; i++) {
      var ta = i / rimN, tb = (i + 1) / rimN;
      var A = P(uu, ta), B = P(uu, tb);
      var mid = A.clone().add(B).multiplyScalar(0.5);
      var dir = B.clone().sub(A);
      var lenSeg = dir.length();
      var ang = Math.atan2(dir.y, dir.x);
      var rim = new T.BoxGeometry(lenSeg * 1.25, 0.85, 1.5);
      var mm = trs(opt.x, opt.y, opt.z, 0, opt.ry || 0, 0)
        .multiply(trs(mid.x * 1.03, mid.y * 1.03, mid.z + 0.35, 0, 0, ang));
      bWhite.add(rim, mm, CREAM);
    }
  }

  /* --------------------------------------------------------- terrace band */
  function addTerrace(bWall, bGreen, bFlower, curvePts, level, bandW, wallH, rng) {
    var curve = new T.CatmullRomCurve3(curvePts.map(function (p) { return new T.Vector3(p[0], level, p[1]); }));
    var N = 90, pos = [], idx = [], cols = [];
    var pts = [], tans = [];
    for (var i = 0; i <= N; i++) { pts.push(curve.getPoint(i / N)); tans.push(curve.getTangent(i / N)); }
    var up = new T.Vector3(0, 1, 0);
    for (i = 0; i <= N; i++) {
      var nrm = new T.Vector3().crossVectors(tans[i], up).normalize();
      var pIn = pts[i].clone().addScaledVector(nrm, -bandW * 0.5);
      var pOut = pts[i].clone().addScaledVector(nrm, bandW * 0.5);
      var pLow = pOut.clone(); pLow.y -= wallH;
      // top band (inner, outer) + wall bottom
      [pIn, pOut, pLow].forEach(function (p) { pos.push(p.x, p.y, p.z); });
      var gc = K.C('#8f9c58').lerp(K.C('#5d7238'), K.fbm(pIn.x * 0.2, pIn.z * 0.2, 2));
      cols.push(gc.r, gc.g, gc.b);
      cols.push(0.94, 0.90, 0.83); cols.push(0.86, 0.82, 0.75);
    }
    for (i = 0; i < N; i++) {
      var a = i * 3, b = (i + 1) * 3;
      idx.push(a, a + 1, b, a + 1, b + 1, b);          // top band
      idx.push(a + 1, a + 2, b + 1, a + 2, b + 2, b + 1); // wall face
    }
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(cols, 3));
    g.setIndex(idx); g.computeVertexNormals();
    var base = bWall.n, p2 = g.attributes.position, n2 = g.attributes.normal, c2 = g.attributes.color;
    for (i = 0; i < p2.count; i++) {
      bWall.pos.push(p2.getX(i), p2.getY(i), p2.getZ(i));
      bWall.nor.push(n2.getX(i), n2.getY(i), n2.getZ(i));
      bWall.col.push(c2.getX(i), c2.getY(i), c2.getZ(i));
    }
    var ix = g.index.array;
    for (i = 0; i < ix.length; i++) bWall.idx.push(base + ix[i]);
    bWall.n += p2.count;

    // hedge rows + flower clumps riding the terrace
    var hedgeGeo = new T.BoxGeometry(1, 1, 1);
    var flowerGeo = new T.IcosahedronGeometry(0.5, 0);
    for (i = 0; i < N; i += 2) {
      var t = i / N, pt = curve.getPoint(t), tg = curve.getTangent(t);
      var nr2 = new T.Vector3().crossVectors(tg, up).normalize();
      var ang2 = Math.atan2(tg.x, tg.z);
      if (rng() < 0.86) {
        var hp = pt.clone().addScaledVector(nr2, bandW * 0.18);
        bGreen.add(hedgeGeo, trs(hp.x, hp.y + 0.75, hp.z, 0, ang2, 0, 1.5, 1.5, 5.4),
          K.C('#3f5a2c').lerp(K.C('#587a33'), rng()), 0.03);
      }
      if (rng() < 0.7) {
        var fp2 = pt.clone().addScaledVector(nr2, -bandW * 0.26);
        var fc = [K.C('#c8484a'), K.C('#d97b2e'), K.C('#c9b24a'), K.C('#b8556f'), K.C('#e0e0d0')][(rng() * 5) | 0];
        for (var k = 0; k < 4; k++) {
          bFlower.add(flowerGeo, trs(fp2.x + (rng() - .5) * 3.4, fp2.y + 0.45 + rng() * 0.5,
            fp2.z + (rng() - .5) * 4.2, 0, 0, 0, 0.9, 0.7, 0.9), fc, 0.06);
        }
      }
    }
  }

  global.ValleyScene._build = {
    Builder: Builder, trs: trs, shellSurface: shellSurface,
    addShell: addShell, addTerrace: addTerrace,
    CREAM: CREAM, CREAM2: CREAM2, GLASSC: GLASSC, FRAME: FRAME, WARM: WARM
  };
})(window);

/* =====================================================================
   Part D — promenade, ring building, town, vegetation, life
   ===================================================================== */
(function (global) {
  'use strict';
  var T = global.THREE, K = global.ValleyScene._core, B = global.ValleyScene._build;
  var W = K.W, terrainH = K.terrainH, trs = B.trs, Builder = B.Builder;

  /* ------------------------------------------------------------ promenade */
  function promY(z) { return Math.max(terrainH(W.promX(z), z), 1.2) + 2.4; }

  function addPromenade(bDeck, bWall, bWarm, rng) {
    var z0 = 205, z1 = -1000, N = 150, hw = W.promHalf;
    var pos = [], idx = [], cols = [], i;
    for (i = 0; i <= N; i++) {
      var z = K.lerp(z0, z1, i / N), cx = W.promX(z), y = promY(z);
      var w = hw * K.lerp(1.0, 0.72, i / N);
      pos.push(cx - w, y, z, cx + w, y, z, cx - w, y - 3.2, z, cx + w, y - 3.2, z);
      var s = 0.90 + K.fbm(cx * 0.3, z * 0.3, 2) * 0.10;
      cols.push(0.93 * s, 0.91 * s, 0.86 * s, 0.93 * s, 0.91 * s, 0.86 * s,
        0.72 * s, 0.69 * s, 0.64 * s, 0.72 * s, 0.69 * s, 0.64 * s);
    }
    for (i = 0; i < N; i++) {
      var a = i * 4, b = (i + 1) * 4;
      idx.push(a, a + 1, b, a + 1, b + 1, b);                     // deck
      idx.push(a + 2, a, b + 2, a, b, b + 2);                     // left flank
      idx.push(a + 1, a + 3, b + 1, a + 3, b + 3, b + 1);         // right flank
    }
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(cols, 3));
    g.setIndex(idx); g.computeVertexNormals();
    var base = bDeck.n, p2 = g.attributes.position, n2 = g.attributes.normal, c2 = g.attributes.color;
    for (i = 0; i < p2.count; i++) {
      bDeck.pos.push(p2.getX(i), p2.getY(i), p2.getZ(i));
      bDeck.nor.push(n2.getX(i), n2.getY(i), n2.getZ(i));
      bDeck.col.push(c2.getX(i), c2.getY(i), c2.getZ(i));
    }
    var ix = g.index.array; for (i = 0; i < ix.length; i++) bDeck.idx.push(base + ix[i]);
    bDeck.n += p2.count;

    // low parapet + lamp posts
    var rail = new T.BoxGeometry(0.5, 0.85, 3.0), lamp = new T.CylinderGeometry(0.11, 0.14, 4.2, 6);
    var bulb = new T.SphereGeometry(0.30, 7, 6);
    for (i = 0; i < N; i += 1) {
      var t = i / N, z2 = K.lerp(z0, z1, t), cx2 = W.promX(z2), y2 = promY(z2);
      var w2 = hw * K.lerp(1.0, 0.72, t);
      bWall.add(rail, trs(cx2 - w2 + 0.2, y2 + 0.42, z2), B.CREAM);
      bWall.add(rail, trs(cx2 + w2 - 0.2, y2 + 0.42, z2), B.CREAM);
      if (i % 6 === 0 && t < 0.62) {
        bWall.add(lamp, trs(cx2 + w2 - 1.1, y2 + 2.1, z2), K.C('#b9b2a4'));
        bWarm.add(bulb, trs(cx2 + w2 - 1.1, y2 + 4.3, z2), K.C('#ffd9a0'));
      }
    }
  }

  /* ------------------------------------------------------- ring building */
  function addRingBuilding(bWhite, bGlass, bWarm, x, z, R, tube, ry) {
    var y = terrainH(x, z) + R * 0.86;
    var torus = new T.TorusGeometry(R, tube, 14, 56);
    bWhite.add(torus, trs(x, y, z, 0.06, ry, 0.04), B.CREAM);
    // glazed annulus on the camera-facing side
    var ring = new T.RingGeometry(tube * 0.9, R + tube * 0.62, 60, 1);
    var m = trs(x, y, z, 0.06, ry, 0.04).multiply(trs(0, 0, tube * 0.92));
    bGlass.add(ring, m, K.C('#2b3f46'));
    for (var w2 = 1; w2 <= 3; w2++) {
      var rw = tube * 0.9 + (R + tube * 0.62 - tube * 0.9) * (w2 / 4);
      bWarm.add(new T.TorusGeometry(rw, 0.75, 6, 40),
        trs(x, y, z, 0.06, ry, 0.04).multiply(trs(0, 0, tube * 1.02)), K.C('#c98a3c'));
    }
    // concentric glazing ribs
    for (var i = 1; i <= 3; i++) {
      var rr = tube * 0.9 + (R + tube * 0.62 - tube * 0.9) * (i / 4);
      bWhite.add(new T.TorusGeometry(rr, 0.55, 6, 40),
        trs(x, y, z, 0.06, ry, 0.04).multiply(trs(0, 0, tube * 0.98)), B.FRAME);
    }
    bWhite.add(new T.TorusGeometry(tube * 0.9, 1.5, 8, 30),
      trs(x, y, z, 0.06, ry, 0.04).multiply(trs(0, 0, tube * 0.95)), B.CREAM);
    // plinth / podium
    bWhite.add(new T.BoxGeometry(R * 2.5, 9, R * 1.15),
      trs(x, terrainH(x, z) + 1.5, z + tube * 0.4, 0, ry, 0), B.CREAM2);
  }

  /* ------------------------------------------------------------ low-rise */
  function addTown(bWhite, bGlass, bWarm, rng) {
    var spots = [];
    var i, x, z;
    // right bank cluster
    for (i = 0; i < 30; i++) {
      x = 175 + rng() * 330; z = -300 - rng() * 620;
      spots.push([x, z, 12 + rng() * 26, 7 + rng() * 12, 10 + rng() * 22]);
    }
    // far centre town (behind the river, near the horizon haze)
    for (i = 0; i < 54; i++) {
      x = -320 + rng() * 820; z = -900 - rng() * 620;
      spots.push([x, z, 14 + rng() * 30, 6 + rng() * 10, 12 + rng() * 26]);
    }
    // left mid-slope outbuildings
    for (i = 0; i < 16; i++) {
      x = -90 - rng() * 190; z = -300 - rng() * 420;
      spots.push([x, z, 10 + rng() * 18, 6 + rng() * 9, 9 + rng() * 16]);
    }
    for (i = 0; i < spots.length; i++) {
      var s = spots[i], sx = s[0], sz = s[1], w = s[2], h = s[3], d = s[4];
      var rx = W.riverX(sz);
      if (Math.abs(sx - rx) < W.riverHalf(sz) * 2.1) continue;
      if (Math.abs(sx - W.promX(sz)) < 26) continue;
      var gy = terrainH(sx, sz);
      var ry = (rng() - 0.5) * 0.7;
      var tone = 0.86 + rng() * 0.14;
      var col = B.CREAM.clone().multiplyScalar(tone);
      bWhite.add(new T.BoxGeometry(w, h, d), trs(sx, gy + h / 2, sz, 0, ry, 0), col);
      bWhite.add(new T.BoxGeometry(w * 1.10, 0.7, d * 1.10), trs(sx, gy + h + 0.3, sz, 0, ry, 0), B.CREAM2);
      // window band
      var wb = new T.BoxGeometry(w * 1.008, h * 0.30, d * 1.008);
      bGlass.add(wb, trs(sx, gy + h * 0.58, sz, 0, ry, 0), K.C('#26363c'));
      bWarm.add(new T.BoxGeometry(w * 1.016, h * 0.105, d * 1.016),
        trs(sx, gy + h * 0.58, sz, 0, ry, 0), K.C('#e08430'));
      if (h > 11) {
        bGlass.add(new T.BoxGeometry(w * 1.008, h * 0.20, d * 1.008),
          trs(sx, gy + h * 0.24, sz, 0, ry, 0), K.C('#26363c'));
        bWarm.add(new T.BoxGeometry(w * 1.016, h * 0.07, d * 1.016),
          trs(sx, gy + h * 0.24, sz, 0, ry, 0), K.C('#c9762a'));
      }
    }
  }

  /* ---------------------------------------------------------- vegetation */
  function lumpyCanopy(seed, squash) {
    var g = new T.IcosahedronGeometry(1, 2);
    var p = g.attributes.position, v = new T.Vector3();
    for (var i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      var n = K.fbm(v.x * 1.6 + seed * 13, v.z * 1.6 + v.y * 1.9 + seed * 7, 3);
      var r = 0.74 + n * 0.62;
      v.multiplyScalar(r);
      v.y *= squash;
      v.y += 0.16;
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return g;
  }

  function vegetation(rng) {
    var canopy = new T.IcosahedronGeometry(1, 1);
    var cypress = new T.ConeGeometry(1, 4.4, 7, 1);
    var trunk = new T.CylinderGeometry(0.14, 0.22, 1, 5);

    var data = { dark: [], mid: [], autumn: [], cyp: [], trunk: [], orchard: [], otrunk: [], fruit: [], shrub: [] };
    var i, x, z, y, s;

    function blocked(x, z) {
      if (Math.abs(x - W.riverX(z)) < W.riverHalf(z) * 1.9 && z < -180) return true;
      if (z < 210 && z > -1000 && Math.abs(x - W.promX(z)) < W.promHalf + 5) return true;
      if (z >= 150 && Math.abs(x - (33 - (z - 166) * 0.18)) < 6.0) return true;   // garden path
      return false;
    }

    // ---- forest on the right slope + distance
    for (i = 0; i < 3400; i++) {
      x = -900 + rng() * 1900; z = 210 - rng() * 1750;
      if (blocked(x, z)) continue;
      y = terrainH(x, z);
      if (y < -2) continue;
      var dens = K.clamp01(0.38 + K.fbm(x * 0.0055 + 7, z * 0.0055 + 3, 3) * 1.30);
      if (rng() > dens) continue;
      if (z > 80 && Math.abs(x - W.camX) < 520) continue;
      s = 3.0 + rng() * 6.5;
      var far = K.clamp01((-z) / 900);
      var e = { x: x, y: y, z: z, s: s, sy: s * (0.85 + rng() * 0.55), r: rng() * 6.28 };
      var pick = rng();
      if (pick < 0.085 && z > -760) data.autumn.push(e);
      else if (pick < 0.14) data.mid.push(e);
      else data.dark.push(e);
      if (z > -420 && s > 4.2) data.trunk.push({ x: x, y: y, z: z, s: s });
    }

    // ---- riverside groves and hedgerows on the flood plain
    for (i = 0; i < 900; i++) {
      x = -260 + rng() * 900; z = -240 - rng() * 900;
      var rxx = W.riverX(z), rhh = W.riverHalf(z), dd = Math.abs(x - rxx);
      if (dd < rhh * 1.5) continue;
      if (Math.abs(x - W.promX(z)) < W.promHalf + 8) continue;
      y = terrainH(x, z);
      if (y < -3 || y > 42) continue;
      var near = 1.0 - K.clamp01((dd - rhh) / 130);
      if (rng() > 0.28 + near * 0.6) continue;
      s = 3.2 + rng() * 5.0;
      data.dark.push({ x: x, y: y, z: z, s: s, sy: s * (0.8 + rng() * 0.6), r: rng() * 6.28 });
    }

    // ---- cypress accents (left terraces + right slope)
    for (i = 0; i < 260; i++) {
      x = -520 + rng() * 1200; z = 160 - rng() * 900;
      if (blocked(x, z)) continue;
      y = terrainH(x, z);
      if (y < 0) continue;
      data.cyp.push({ x: x, y: y, z: z, s: 1.5 + rng() * 1.7, sy: 1.0 + rng() * 1.1, r: rng() * 6.28 });
    }

    // ---- shrubs / low bushes everywhere near the camera
    for (i = 0; i < 3600; i++) {
      x = -520 + rng() * 1100; z = 300 - rng() * 850;
      if (blocked(x, z)) continue;
      y = terrainH(x, z);
      if (y < -1) continue;
      var nearCam = z > 150 && Math.abs(x - W.camX) < 320;
      data.shrub.push({ x: x, y: y, z: z, s: (nearCam ? 0.9 + rng() * 1.5 : 1.1 + rng() * 2.6), r: rng() * 6.28 });
    }

    // ---- wildflower meadow clumps in the near field
    data.flower = [];
    for (i = 0; i < 1500; i++) {
      var fd = 14 + Math.sqrt(rng()) * 300;
      var fz = W.camZ - fd, fx = (W.camX - fd * 0.123) + (rng() - 0.5) * (20 + fd * 1.26);
      if (blocked(fx, fz)) continue;
      var kk = (rng() * 5) | 0, nn = 3 + (rng() * 5) | 0;
      for (var q = 0; q < nn; q++) {
        var ox = fx + (rng() - 0.5) * 2.6, oz = fz + (rng() - 0.5) * 2.6;
        data.flower.push({ x: ox, y: terrainH(ox, oz), z: oz, s: 0.085 + rng() * 0.10, k: kk });
      }
    }

    // ---- foreground orchard on the near ridge
    for (i = 0; i < 2400; i++) {
      var dcam = 32 + Math.sqrt(rng()) * 295;
      z = W.camZ - dcam;
      var axis = W.camX - dcam * 0.123;
      x = axis + (rng() - 0.5) * (26 + dcam * 1.20);
      if (blocked(x, z)) continue;
      y = terrainH(x, z);
      var sc = 1.15 + rng() * 1.6;
      data.orchard.push({ x: x, y: y + sc * 0.78, z: z, s: sc, r: rng() * 6.28 });
      data.otrunk.push({ x: x, y: y, z: z, s: sc });
      var nf = 4 + (rng() * 6) | 0;
      for (var f = 0; f < nf; f++) {
        var a = rng() * 6.28, rr = sc * (0.5 + rng() * 0.5);
        data.fruit.push({
          x: x + Math.cos(a) * rr, y: y + sc * (1.45 + rng() * 0.75),
          z: z + Math.sin(a) * rr, s: 0.11 + rng() * 0.07
        });
      }
    }
    return { geo: { canopy: canopy, cypress: cypress, trunk: trunk }, data: data };
  }

  function instanced(geo, mat, list, cb) {
    var n = list.length;
    var im = new T.InstancedMesh(geo, mat, Math.max(n, 1));
    var m = new T.Matrix4();
    for (var i = 0; i < n; i++) { cb(m, list[i], i); im.setMatrixAt(i, m); }
    im.count = n;
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;
    return im;
  }

  global.ValleyScene._parts = {
    addPromenade: addPromenade, addRingBuilding: addRingBuilding,
    addTown: addTown, vegetation: vegetation, instanced: instanced, promY: promY,
    lumpyCanopy: lumpyCanopy
  };
})(window);

/* =====================================================================
   Part E — life (people, birds, grass, lights) + post FX + main
   ===================================================================== */
(function (global) {
  'use strict';
  var T = global.THREE, K = global.ValleyScene._core, B = global.ValleyScene._build, P = global.ValleyScene._parts;
  var W = K.W, terrainH = K.terrainH, trs = B.trs, Builder = B.Builder;

  /* --------------------------------------------------------- small props */
  function figureGeo() {
    var b = new Builder(), white = K.C('#ffffff');
    b.add(new T.CylinderGeometry(0.155, 0.21, 1.02, 6), trs(0, 0.52, 0), white);
    b.add(new T.CylinderGeometry(0.10, 0.13, 0.62, 5), trs(-0.10, 0.14, 0), white);
    b.add(new T.CylinderGeometry(0.10, 0.13, 0.62, 5), trs(0.10, 0.14, 0), white);
    b.add(new T.SphereGeometry(0.155, 7, 6), trs(0, 1.22, 0), white);
    return b.build();
  }
  function parasolGeo() {
    var pts = [];
    for (var i = 0; i <= 10; i++) {
      var t = i / 10;
      pts.push(new T.Vector2(t * 3.1, 0.95 - Math.pow(t, 1.9) * 0.95));
    }
    var b = new Builder();
    b.add(new T.LatheGeometry(pts, 14), trs(0, 2.6, 0), K.C('#f4efe4'));
    b.add(new T.CylinderGeometry(0.055, 0.065, 2.7, 6), trs(0, 1.35, 0), K.C('#c9c1b2'));
    return b.build(true);
  }
  function bladeGeo() {
    var g = new T.BufferGeometry();
    var p = [-0.042, 0, 0, 0.042, 0, 0, -0.026, 0.58, 0.05, 0.026, 0.58, 0.05, 0, 1.0, 0.16];
    var c = [0.30, 0.34, 0.16, 0.30, 0.34, 0.16, 0.62, 0.62, 0.30, 0.62, 0.62, 0.30, 1.00, 0.94, 0.52];
    g.setAttribute('position', new T.Float32BufferAttribute(p, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(c, 3));
    g.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
    g.computeVertexNormals();
    return g;
  }
  function birdGeo() {
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(
      [0, 0, 0, -1, 0.42, -0.30, -0.72, 0, 0.34, 0, 0, 0, 0.72, 0, 0.34, 1, 0.42, -0.30], 3));
    g.setIndex([0, 1, 2, 3, 5, 4]);
    g.computeVertexNormals();
    return g;
  }

  /* ------------------------------------------------------- post-process */
  var QUAD_VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.0,1.0); }';

  var BRIGHT_FS = [
    'precision highp float; varying vec2 vUv; uniform sampler2D tDiff; uniform float uThresh, uKnee;',
    'void main(){ vec3 c = texture2D(tDiff, vUv).rgb;',
    '  float l = dot(c, vec3(0.2126,0.7152,0.0722));',
    '  float s = smoothstep(uThresh, uThresh+uKnee, l);',
    '  gl_FragColor = vec4(c*s, 1.0); }'
  ].join('\n');

  var BLUR_FS = [
    'precision highp float; varying vec2 vUv; uniform sampler2D tDiff; uniform vec2 uDir; uniform vec2 uRes;',
    'void main(){ vec2 t = uDir/uRes; vec3 s = vec3(0.0);',
    '  s += texture2D(tDiff, vUv - t*4.0).rgb*0.0162;',
    '  s += texture2D(tDiff, vUv - t*3.0).rgb*0.0540;',
    '  s += texture2D(tDiff, vUv - t*2.0).rgb*0.1216;',
    '  s += texture2D(tDiff, vUv - t*1.0).rgb*0.1946;',
    '  s += texture2D(tDiff, vUv          ).rgb*0.2270;',
    '  s += texture2D(tDiff, vUv + t*1.0).rgb*0.1946;',
    '  s += texture2D(tDiff, vUv + t*2.0).rgb*0.1216;',
    '  s += texture2D(tDiff, vUv + t*3.0).rgb*0.0540;',
    '  s += texture2D(tDiff, vUv + t*4.0).rgb*0.0162;',
    '  gl_FragColor = vec4(s,1.0); }'
  ].join('\n');

  var COMP_FS = [
    'precision highp float; varying vec2 vUv;',
    'uniform sampler2D tScene, tB1, tB2, tB3;',
    'uniform float uBloom, uExp, uVig, uGrain, uTime, uSat, uLift, uCon;',
    'uniform vec3 uTint;',
    'vec3 aces(vec3 x){ const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;',
    '  return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.0,1.0); }',
    'float h(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }',
    'void main(){',
    '  vec3 col = texture2D(tScene, vUv).rgb;',
    '  vec3 bl = texture2D(tB1,vUv).rgb*0.40 + texture2D(tB2,vUv).rgb*0.30 + texture2D(tB3,vUv).rgb*0.26;',
    '  col += bl * uBloom;',
    '  col *= uExp;',
    '  col *= uTint;',
    '  col = aces(col);',
    '  col = clamp((col - 0.5) * uCon + 0.5, 0.0, 1.0);',
    '  float l = dot(col, vec3(0.2126,0.7152,0.0722));',
    '  col = mix(vec3(l), col, uSat);',
    '  col += uLift * (1.0 - l) * vec3(0.030,0.036,0.056);',
    '  vec2 q = vUv - 0.5; q.x *= 1.06;',
    '  float v = 1.0 - dot(q,q)*uVig;',
    '  col *= clamp(v,0.0,1.0);',
    '  col += (h(vUv*vec2(1024.0,768.0) + uTime) - 0.5) * uGrain;',
    '  gl_FragColor = vec4(pow(clamp(col,0.0,1.0), vec3(1.0/2.2)), 1.0);',
    '}'
  ].join('\n');

  function Post(renderer, w, h) {
    this.r = renderer;
    var hf = { type: T.HalfFloatType, minFilter: T.LinearFilter, magFilter: T.LinearFilter, depthBuffer: true };
    var hf2 = { type: T.HalfFloatType, minFilter: T.LinearFilter, magFilter: T.LinearFilter, depthBuffer: false };
    this.scene = new T.WebGLRenderTarget(w, h, hf);
    this.b1a = new T.WebGLRenderTarget(w >> 1, h >> 1, hf2);
    this.b1b = new T.WebGLRenderTarget(w >> 1, h >> 1, hf2);
    this.b2a = new T.WebGLRenderTarget(w >> 2, h >> 2, hf2);
    this.b2b = new T.WebGLRenderTarget(w >> 2, h >> 2, hf2);
    this.b3a = new T.WebGLRenderTarget(w >> 3, h >> 3, hf2);
    this.b3b = new T.WebGLRenderTarget(w >> 3, h >> 3, hf2);
    this.quad = new T.Mesh(new T.PlaneGeometry(2, 2));
    this.qScene = new T.Scene(); this.qScene.add(this.quad);
    this.qCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mBright = new T.ShaderMaterial({
      uniforms: { tDiff: { value: null }, uThresh: { value: 1.25 }, uKnee: { value: 0.85 } },
      vertexShader: QUAD_VS, fragmentShader: BRIGHT_FS, depthTest: false, depthWrite: false
    });
    this.mBlur = new T.ShaderMaterial({
      uniforms: { tDiff: { value: null }, uDir: { value: new T.Vector2(1, 0) }, uRes: { value: new T.Vector2(w, h) } },
      vertexShader: QUAD_VS, fragmentShader: BLUR_FS, depthTest: false, depthWrite: false
    });
    this.mComp = new T.ShaderMaterial({
      uniforms: {
        tScene: { value: null }, tB1: { value: null }, tB2: { value: null }, tB3: { value: null },
        uBloom: { value: 0.55 }, uExp: { value: 1.0 }, uVig: { value: 0.40 }, uGrain: { value: 0.010 },
        uTime: { value: 0 }, uSat: { value: 1.06 }, uLift: { value: 1.0 }, uCon: { value: 1.10 }, uTint: { value: new T.Vector3(1, 1, 1) }
      },
      vertexShader: QUAD_VS, fragmentShader: COMP_FS, depthTest: false, depthWrite: false
    });
  }
  Post.prototype.setSize = function (w, h) {
    this.scene.setSize(w, h);
    this.b1a.setSize(w >> 1, h >> 1); this.b1b.setSize(w >> 1, h >> 1);
    this.b2a.setSize(w >> 2, h >> 2); this.b2b.setSize(w >> 2, h >> 2);
    this.b3a.setSize(w >> 3, h >> 3); this.b3b.setSize(w >> 3, h >> 3);
  };
  Post.prototype._pass = function (mat, target) {
    this.quad.material = mat;
    this.r.setRenderTarget(target);
    this.r.clear();
    this.r.render(this.qScene, this.qCam);
  };
  Post.prototype._blur = function (src, a, b, w, h, radius) {
    this.mBlur.uniforms.tDiff.value = src.texture;
    this.mBlur.uniforms.uRes.value.set(w, h);
    this.mBlur.uniforms.uDir.value.set(radius, 0); this._pass(this.mBlur, a);
    this.mBlur.uniforms.tDiff.value = a.texture;
    this.mBlur.uniforms.uDir.value.set(0, radius); this._pass(this.mBlur, b);
    this.mBlur.uniforms.tDiff.value = b.texture;
    this.mBlur.uniforms.uDir.value.set(radius * 1.7, 0); this._pass(this.mBlur, a);
    this.mBlur.uniforms.tDiff.value = a.texture;
    this.mBlur.uniforms.uDir.value.set(0, radius * 1.7); this._pass(this.mBlur, b);
    return b;
  };
  Post.prototype.render = function (w, h) {
    this.mBright.uniforms.tDiff.value = this.scene.texture;
    this._pass(this.mBright, this.b1a);
    var r1 = this._blur(this.b1a, this.b1b, this.b1a, w >> 1, h >> 1, 1.0);
    this.mBright.uniforms.tDiff.value = r1.texture;
    this._pass(this.mBright, this.b2a);
    var r2 = this._blur(this.b2a, this.b2b, this.b2a, w >> 2, h >> 2, 1.0);
    this.mBright.uniforms.tDiff.value = r2.texture;
    this._pass(this.mBright, this.b3a);
    var r3 = this._blur(this.b3a, this.b3b, this.b3a, w >> 3, h >> 3, 1.0);
    this.mComp.uniforms.tScene.value = this.scene.texture;
    this.mComp.uniforms.tB1.value = r1.texture;
    this.mComp.uniforms.tB2.value = r2.texture;
    this.mComp.uniforms.tB3.value = r3.texture;
    this.quad.material = this.mComp;
    this.r.setRenderTarget(null);
    this.r.render(this.qScene, this.qCam);
  };

  global.ValleyScene._fx = { Post: Post, figureGeo: figureGeo, parasolGeo: parasolGeo, bladeGeo: bladeGeo, birdGeo: birdGeo };
})(window);

/* =====================================================================
   Part F — assembly, lighting, animation loop, public API
   ===================================================================== */
(function (global) {
  'use strict';
  var T = global.THREE, K = global.ValleyScene._core, B = global.ValleyScene._build;
  var P = global.ValleyScene._parts, FX = global.ValleyScene._fx, WD = global.ValleyScene._world;
  var W = K.W, terrainH = K.terrainH, trs = B.trs, Builder = B.Builder;

  function ensureColor(geo, r, g, b) {
    if (geo.attributes.color) return geo;
    var n = geo.attributes.position.count, a = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) { a[i * 3] = r; a[i * 3 + 1] = g; a[i * 3 + 2] = b; }
    geo.setAttribute('color', new T.BufferAttribute(a, 3));
    return geo;
  }
  function xAtLevel(level, z) {
    var best = -60, bd = 1e9;
    for (var x = -20; x > -430; x -= 3) {
      var d = Math.abs(terrainH(x, z) - level);
      if (d < bd) { bd = d; best = x; }
    }
    return best;
  }
  function contour(level, z0, z1, n) {
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var z = K.lerp(z0, z1, i / n);
      pts.push([xAtLevel(level, z), z]);
    }
    return pts;
  }

  function mount(container, opts) {
    opts = opts || {};
    var rng = K.mulberry32(opts.seed || 20260824);

    /* ---------------------------------------------------------- renderer */
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%';
    container.appendChild(canvas);
    var renderer = new T.WebGLRenderer({ canvas: canvas, antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, opts.maxDPR || 1.75));
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.NoToneMapping;
    renderer.shadowMap.enabled = opts.shadows !== false;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.setClearColor(0x000000, 1);

    var scene = new T.Scene();
    var fog = new T.FogExp2(0xffc98a, 0.00083);
    scene.fog = fog;

    var camera = new T.PerspectiveCamera(opts.fov || 37, 16 / 9, 1, 22000);
    var CAM = opts.camera || { px: W.camX, pz: W.camZ, eye: 9.5, yaw: -8.0, pitch: -6.0 };
    var camPos = new T.Vector3(CAM.px, terrainH(CAM.px, CAM.pz) + CAM.eye, CAM.pz);
    var yawR = CAM.yaw * Math.PI / 180, pitR = CAM.pitch * Math.PI / 180;
    var camDir = new T.Vector3(Math.sin(yawR) * Math.cos(pitR), Math.sin(pitR), -Math.cos(yawR) * Math.cos(pitR));
    camera.position.copy(camPos);
    camera.lookAt(camPos.clone().addScaledVector(camDir, 1000));

    /* ------------------------------------------------------------ lights */
    var sun = new T.DirectionalLight(0xffb267, 3.0);
    sun.castShadow = renderer.shadowMap.enabled;
    if (sun.castShadow) {
      sun.shadow.mapSize.set(opts.shadowMap || 2048, opts.shadowMap || 2048);
      var sc = sun.shadow.camera;
      sc.left = -330; sc.right = 330; sc.top = 330; sc.bottom = -330;
      sc.near = 400; sc.far = 2600;
      sun.shadow.bias = -0.0009; sun.shadow.normalBias = 0.9;
    }
    sun.target.position.set(-40, 30, -120);
    scene.add(sun, sun.target);

    var hemi = new T.HemisphereLight(0x9fb4cc, 0x50442e, 1.0);
    scene.add(hemi);
    var fill = new T.DirectionalLight(0x8fb0d8, 0.35);
    var bounce = new T.DirectionalLight(0xffc98a, 0.30);
    bounce.position.set(-40, 40, 520);
    scene.add(bounce);
    fill.position.set(90, 120, 320);
    scene.add(fill);

    /* ---------------------------------------------------------- the world */
    var sky = WD.makeSky(); scene.add(sky);
    var terrain = WD.makeTerrain(); scene.add(terrain);
    var river = WD.makeRiver(); scene.add(river);
    if (opts.debugWater) { river.material = new T.MeshBasicMaterial({ color: 0xff00ff }); }

    var bWhite = new Builder(), bGreen = new Builder(), bGlass = new Builder(),
      bWarm = new Builder(), bFlower = new Builder(), bDeck = new Builder();

    // --- terraces following real contours of the left hill
    var LEVELS = [
      { y: 44, z0: 40, z1: -560, bw: 22, wh: 5.6 },
      { y: 64, z0: 50, z1: -540, bw: 24, wh: 6.4 },
      { y: 84, z0: 60, z1: -510, bw: 22, wh: 6.4 },
      { y: 104, z0: 70, z1: -480, bw: 20, wh: 5.8 },
      { y: 124, z0: 80, z1: -440, bw: 18, wh: 5.2 }
    ];
    LEVELS.forEach(function (L) {
      B.addTerrace(bWhite, bGreen, bFlower, contour(L.y, L.z0, L.z1, 11), L.y, L.bw, L.wh, rng);
    });

    // --- signature shell buildings
    var SHELLS = [
      { y: 64, z: -70, len: 58, w: 18.0, h: 19.0, ry: -0.30, bend: 4, taper: 0.86, dx: 4 },
      { y: 104, z: -160, len: 46, w: 14.0, h: 15.5, ry: -0.20, bend: 3, taper: 0.88, dx: 2 },
      { y: 44, z: -230, len: 40, w: 11.5, h: 12.5, ry: -0.40, bend: 2, taper: 0.90, dx: 3 },
      { y: 84, z: -340, len: 34, w: 10.0, h: 11.0, ry: -0.26, bend: 2, taper: 0.90, dx: 2 },
      { y: 124, z: -100, len: 34, w: 10.5, h: 11.5, ry: -0.14, bend: 2, taper: 0.90, dx: 2 }
    ];
    SHELLS.forEach(function (sh) {
      sh.x = xAtLevel(sh.y, sh.z) + (sh.dx || 0);
      B.addShell(bWhite, bGreen, bGlass, bWarm, sh);
    });

    // --- parasols on the café terrace
    var pGeo = FX.parasolGeo();
    [[64, -12], [64, -32], [64, -50], [64, 4], [44, -20], [44, -40], [44, -60], [44, -4]]
      .forEach(function (p) {
        var lv = p[0], pz = p[1], px = xAtLevel(lv, pz) + 6 + rng() * 5;
        bWhite.add(pGeo, trs(px, lv, pz, 0, rng() * 6.28, 0, 1.05, 1.0, 1.05), K.C('#ffffff'));
      });

    P.addPromenade(bDeck, bWhite, bWarm, rng);
    P.addRingBuilding(bWhite, bGlass, bWarm, 430, -880, 52, 18, -0.24);
    P.addTown(bWhite, bGlass, bWarm, rng);

    // --- foreground garden path
    (function () {
      var curve = new T.CatmullRomCurve3([
        new T.Vector3(6, 0, 316), new T.Vector3(14, 0, 286), new T.Vector3(22, 0, 254),
        new T.Vector3(28, 0, 222), new T.Vector3(31, 0, 192), new T.Vector3(33, 0, 166)
      ]);
      var N = 72, pos = [], idx = [], cols = [];
      for (var i = 0; i <= N; i++) {
        var t = i / N, pt = curve.getPoint(t), tg = curve.getTangent(t);
        var nr = new T.Vector3(-tg.z, 0, tg.x).normalize();
        var hw = K.lerp(3.2, 2.3, t);
        var y = terrainH(pt.x, pt.z) + 0.35;
        var a = pt.clone().addScaledVector(nr, -hw), b2 = pt.clone().addScaledVector(nr, hw);
        pos.push(a.x, y, a.z, b2.x, y, b2.z);
        var s = 0.86 + K.fbm(pt.x * 0.5, pt.z * 0.5, 2) * 0.16;
        cols.push(0.70 * s, 0.66 * s, 0.57 * s, 0.70 * s, 0.66 * s, 0.57 * s);
      }
      for (i = 0; i < N; i++) { var q = i * 2, r2 = q + 2; idx.push(q, q + 1, r2, q + 1, r2 + 1, r2); }
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new T.Float32BufferAttribute(cols, 3));
      g.setIndex(idx); g.computeVertexNormals();
      var base = bDeck.n, p2 = g.attributes.position, n2 = g.attributes.normal, c2 = g.attributes.color;
      for (i = 0; i < p2.count; i++) {
        bDeck.pos.push(p2.getX(i), p2.getY(i), p2.getZ(i));
        bDeck.nor.push(n2.getX(i), n2.getY(i), n2.getZ(i));
        bDeck.col.push(c2.getX(i), c2.getY(i), c2.getZ(i));
      }
      var ix = g.index.array; for (i = 0; i < ix.length; i++) bDeck.idx.push(base + ix[i]);
      bDeck.n += p2.count;
      global.__pathCurve = curve;
    })();

    // --- slim bollard lights along the near path
    (function () {
      var pole = new T.CylinderGeometry(0.035, 0.05, 1, 5);
      var cap = new T.SphereGeometry(0.085, 6, 5);
      var curve = global.__pathCurve;
      for (var i = 0; i < 13; i++) {
        var t = i / 13, pt = curve.getPoint(t), tg = curve.getTangent(t);
        var nr = new T.Vector3(-tg.z, 0, tg.x).normalize();
        var side = (i % 2 === 0) ? 1 : -1;
        var cx = pt.x + nr.x * side * (5.6 + rng() * 1.6), cz = pt.z + nr.z * side * (5.6 + rng() * 1.6);
        var n = 2 + (rng() * 3) | 0;
        for (var j = 0; j < n; j++) {
          var ox = cx + (rng() - 0.5) * 1.7, oz = cz + (rng() - 0.5) * 1.7;
          var gy = terrainH(ox, oz), hgt = 1.1 + rng() * 1.1;
          bWhite.add(pole, trs(ox, gy + hgt / 2, oz, 0, 0, 0, 1, hgt, 1), K.C('#c8c2b4'));
          bWarm.add(cap, trs(ox, gy + hgt + 0.05, oz), K.C('#ffd79a'));
        }
      }
    })();

    var matWhite = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.68, metalness: 0.02, side: T.DoubleSide });
    var matGreen = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0, side: T.DoubleSide });
    var matGlass = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.22, side: T.DoubleSide, emissive: new T.Color(0x101820) });
    var matFlower = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    var matDeck = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });
    var matWarm = new T.MeshBasicMaterial({ vertexColors: true, side: T.DoubleSide });

    function addMerged(b, mat, cast, receive) {
      if (b.empty()) return null;
      var m = new T.Mesh(b.build(), mat);
      m.castShadow = !!cast; m.receiveShadow = !!receive;
      scene.add(m); return m;
    }
    addMerged(bWhite, matWhite, true, true);
    addMerged(bGreen, matGreen, true, true);
    addMerged(bGlass, matGlass, false, false);
    addMerged(bFlower, matFlower, false, false);
    addMerged(bDeck, matDeck, false, true);
    var warmMesh = addMerged(bWarm, matWarm, false, false);

    /* -------------------------------------------------------- vegetation */
    var veg = P.vegetation(rng);
    var canopy = ensureColor(veg.geo.canopy, 1, 1, 1);
    var canopyA = ensureColor(P.lumpyCanopy(1, 0.86), 1, 1, 1);
    var canopyB = ensureColor(P.lumpyCanopy(2, 0.72), 1, 1, 1);
    var canopyC = ensureColor(P.lumpyCanopy(3, 0.95), 1, 1, 1);
    var cypG = ensureColor(veg.geo.cypress, 1, 1, 1);
    var trunkG = ensureColor(veg.geo.trunk, 1, 1, 1);
    var matLeaf = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0.0, flatShading: true });
    var matBark = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.98 });

    function foliage(list, geo, mat, palette, cast) {
      if (!list.length) return null;
      var im = new T.InstancedMesh(geo, mat, list.length);
      var m = new T.Matrix4(), c = new T.Color();
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        m.compose(new T.Vector3(e.x, e.y + e.s * 0.62, e.z),
          new T.Quaternion().setFromEuler(new T.Euler(0, e.r || 0, 0)),
          new T.Vector3(e.s, e.sy || e.s, e.s));
        im.setMatrixAt(i, m);
        c.copy(palette[(Math.random() * palette.length) | 0]);
        var j = (Math.random() - 0.5) * 0.10;
        c.offsetHSL(0, (Math.random() - 0.5) * 0.06, j * 0.5);
        im.setColorAt(i, c);
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = !!cast; im.receiveShadow = true; im.frustumCulled = false;
      scene.add(im); return im;
    }
    var PDARK = [K.C('#2c4a24'), K.C('#365a2b'), K.C('#254020'), K.C('#3f6630')];
    var PMID = [K.C('#5f7f36'), K.C('#728f42'), K.C('#527230')];
    var PAUT = [K.C('#b8461f'), K.C('#cf6a22'), K.C('#a8371c'), K.C('#d98a2b')];
    var PCYP = [K.C('#20351f'), K.C('#284022'), K.C('#1b2d1a')];
    var PSHR = [K.C('#50693a'), K.C('#647d46'), K.C('#425831')];
    var PORC = [K.C('#6b8a3c'), K.C('#7d9a46'), K.C('#5d7c34'), K.C('#89a052')];

    var VARS = [canopyA, canopyB, canopyC];
    function foliageMix(list, mat, palette, cast) {
      var buckets = [[], [], []];
      for (var i = 0; i < list.length; i++) buckets[i % 3].push(list[i]);
      for (i = 0; i < 3; i++) foliage(buckets[i], VARS[i], mat, palette, cast);
    }
    foliageMix(veg.data.dark, matLeaf, PDARK, true);
    foliageMix(veg.data.mid, matLeaf, PMID, true);
    foliageMix(veg.data.autumn, matLeaf, PAUT, true);
    foliage(veg.data.cyp, cypG, matLeaf, PCYP, true);
    foliageMix(veg.data.shrub, matLeaf, PSHR, false);
    foliageMix(veg.data.orchard, matLeaf, PORC, true);
    (function () {
      var l = veg.data.otrunk;
      if (!l || !l.length) return;
      var im = new T.InstancedMesh(trunkG, matBark, l.length), m = new T.Matrix4(), c = new T.Color('#4a3a26');
      for (var i = 0; i < l.length; i++) {
        var e = l[i];
        m.compose(new T.Vector3(e.x, e.y + e.s * 0.42, e.z), new T.Quaternion(), new T.Vector3(e.s * 0.10, e.s * 0.95, e.s * 0.10));
        im.setMatrixAt(i, m); im.setColorAt(i, c);
      }
      im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; im.castShadow = true;
      scene.add(im);
    })();
    (function () {
      var l = veg.data.trunk;
      if (!l.length) return;
      var im = new T.InstancedMesh(trunkG, matBark, l.length), m = new T.Matrix4(), c = new T.Color('#3c2f22');
      for (var i = 0; i < l.length; i++) {
        var e = l[i];
        m.compose(new T.Vector3(e.x, e.y + e.s * 0.32, e.z), new T.Quaternion(), new T.Vector3(e.s * 0.14, e.s * 0.75, e.s * 0.14));
        im.setMatrixAt(i, m); im.setColorAt(i, c);
      }
      im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; im.castShadow = true;
      scene.add(im);
    })();
    (function () {
      var l = veg.data.flower;
      if (!l || !l.length) return;
      var g = ensureColor(new T.IcosahedronGeometry(1, 0), 1, 1, 1);
      var mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
      var im = new T.InstancedMesh(g, mat, l.length), m = new T.Matrix4(), c = new T.Color();
      var pal = [K.C('#d8d2b4'), K.C('#c8687a'), K.C('#d99a34'), K.C('#b7a8cc'), K.C('#e0c85a')];
      for (var i = 0; i < l.length; i++) {
        var e = l[i];
        m.compose(new T.Vector3(e.x, e.y + 0.55 + e.s, e.z), new T.Quaternion(), new T.Vector3(e.s, e.s * 0.8, e.s));
        im.setMatrixAt(i, m); im.setColorAt(i, c.copy(pal[e.k]));
      }
      im.instanceMatrix.needsUpdate = true; im.frustumCulled = false;
      scene.add(im);
    })();
    (function () {
      var l = veg.data.fruit;
      if (!l.length) return;
      var g = ensureColor(new T.OctahedronGeometry(1, 0), 1, 1, 1);
      var mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, emissive: 0x000000 });
      var im = new T.InstancedMesh(g, mat, l.length), m = new T.Matrix4(), c = new T.Color();
      var pal = [K.C('#d9541f'), K.C('#e0761f'), K.C('#c8431a'), K.C('#e8a02a')];
      for (var i = 0; i < l.length; i++) {
        var e = l[i];
        m.compose(new T.Vector3(e.x, e.y, e.z), new T.Quaternion(), new T.Vector3(e.s, e.s, e.s));
        im.setMatrixAt(i, m); im.setColorAt(i, c.copy(pal[(Math.random() * 4) | 0]));
      }
      im.instanceMatrix.needsUpdate = true; im.frustumCulled = false;
      scene.add(im);
    })();

    /* -------------------------------------------------------------- grass */
    (function () {
      var g = FX.bladeGeo();
      var mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 1.0, side: T.DoubleSide });
      var N = opts.grass === undefined ? 130000 : opts.grass;
      var im = new T.InstancedMesh(g, mat, N), m = new T.Matrix4(), c = new T.Color();
      var pal = [K.C('#b3b76a'), K.C('#c9c078'), K.C('#93a355'), K.C('#dcca86'), K.C('#a4b060')];
      var k = 0;
      for (var i = 0; i < N * 3 && k < N; i++) {
        var dc = 6 + Math.sqrt(rng()) * 310, z = W.camZ - dc,
          x = (W.camX - dc * 0.123) + (rng() - 0.5) * (22 + dc * 1.24);
        if (Math.abs(x - W.promX(z)) < W.promHalf + 2) continue;
        var y = terrainH(x, z);
        var gs = 0.85 + rng() * 0.9;
        m.compose(new T.Vector3(x, y, z), new T.Quaternion().setFromEuler(new T.Euler(0, rng() * 6.28, (rng() - .5) * 0.30)),
          new T.Vector3(gs, 0.52 + rng() * 0.85, gs));
        im.setMatrixAt(k, m); im.setColorAt(k, c.copy(pal[(rng() * 4) | 0]));
        k++;
      }
      im.count = k; im.instanceMatrix.needsUpdate = true; im.frustumCulled = false;
      scene.add(im);
    })();

    /* ------------------------------------------------------------ people */
    var people = [];
    (function () {
      var g = FX.figureGeo();
      var mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
      var N = 96;
      var im = new T.InstancedMesh(g, mat, N), c = new T.Color();
      var pal = [K.C('#5b6472'), K.C('#96574a'), K.C('#e6e0d4'), K.C('#6d7c8c'), K.C('#b0805c'), K.C('#cdc6b8')];
      for (var i = 0; i < N; i++) {
        var onPath = i < 10;
        people.push({
          onPath: onPath, t: rng(), speed: (0.006 + rng() * 0.008) * (rng() < 0.5 ? 1 : -1),
          lat: (rng() - 0.5) * (onPath ? 5.0 : 16.0), scale: 1.15 + rng() * 0.22, ph: rng() * 6.28
        });
        im.setColorAt(i, c.copy(pal[(rng() * 6) | 0]));
      }
      im.frustumCulled = false; im.castShadow = true;
      scene.add(im);
      people.mesh = im;
    })();

    /* ------------------------------------------------------------- birds */
    var birds = [];
    (function () {
      var g = ensureColor(FX.birdGeo(), 1, 1, 1);
      var mat = new T.MeshBasicMaterial({ vertexColors: true, side: T.DoubleSide });
      var N = 58;
      var im = new T.InstancedMesh(g, mat, N), c = new T.Color('#2a2b30');
      for (var i = 0; i < N; i++) {
        birds.push({
          x: 240 + rng() * 660, y: 205 + rng() * 165, z: -400 - rng() * 780,
          s: 3.0 + rng() * 3.2, ph: rng() * 6.28, sp: 6 + rng() * 8, a: rng() * 6.28
        });
        im.setColorAt(i, c);
      }
      im.frustumCulled = false;
      scene.add(im);
      birds.mesh = im;
    })();

    /* ---------------------------------------------------- framing canopy */
    (function () {
      var g = ensureColor(new T.IcosahedronGeometry(1, 1), 1, 1, 1);
      var mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
      var spots = [
        [-196, 250, 22], [-232, 226, 20], [-168, 276, 18], [-268, 200, 23],
        [226, 250, 16], [262, 226, 14]
      ];
      var im = new T.InstancedMesh(g, mat, spots.length), m = new T.Matrix4(), c = new T.Color('#31491f');
      for (var i = 0; i < spots.length; i++) {
        var s = spots[i], y = terrainH(s[0], s[1]);
        m.compose(new T.Vector3(s[0], y + s[2] * 0.9, s[1]), new T.Quaternion().setFromEuler(new T.Euler(0, i, 0)),
          new T.Vector3(s[2], s[2] * 0.8, s[2]));
        im.setMatrixAt(i, m); im.setColorAt(i, c);
      }
      im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; im.castShadow = true;
      scene.add(im);
    })();

    /* ----------------------------------------------------------- post FX */
    var size = new T.Vector2();
    function currentSize() {
      var w = container.clientWidth || 1280, h = container.clientHeight || 720;
      return [Math.max(2, w), Math.max(2, h)];
    }
    var cs = currentSize();
    var dpr = renderer.getPixelRatio();
    // fx:false skips the bloom/grade pipeline entirely (~16 full-screen
    // passes per frame) for software rasterizers; ACES + exposure stands
    // in for the comp pass so day/night brightness still tracks.
    var post = opts.fx === false ? null : new FX.Post(renderer, Math.floor(cs[0] * dpr), Math.floor(cs[1] * dpr));
    if (!post) renderer.toneMapping = T.ACESFilmicToneMapping;

    var BASE_FOV = opts.fov || 37, BASE_ASPECT = 16 / 9;
    function resize() {
      var s = currentSize();
      renderer.setSize(s[0], s[1], false);
      var asp = s[0] / s[1];
      camera.aspect = asp;
      // hold the horizontal field of view when the frame gets narrow
      camera.fov = asp < BASE_ASPECT
        ? 2 * Math.atan(Math.tan(BASE_FOV * Math.PI / 360) * (BASE_ASPECT / asp)) * 180 / Math.PI
        : BASE_FOV;
      camera.fov = Math.min(camera.fov, 76);
      camera.updateProjectionMatrix();
      var d = renderer.getPixelRatio();
      if (post) post.setSize(Math.floor(s[0] * d), Math.floor(s[1] * d));
    }
    resize();
    var ro = null;
    if (global.ResizeObserver) { ro = new ResizeObserver(resize); ro.observe(container); }
    global.addEventListener('resize', resize);

    /* ------------------------------------------------------ time of day */
    var state = { hours: 20.3, auto: opts.time === undefined, speed: opts.speed || 0 };
    if (opts.time !== undefined) state.hours = opts.time;

    var skyU = sky.userData.uniforms, watU = river.userData.uniforms;
    var moonDir = new T.Vector3();

    function applyTime(h) {
      var S = K.sunState(h), pal = K.palAt(S.elevDeg);
      var night = K.clamp01((-S.elevDeg - 1.0) / 9.0);
      var sunUp = K.clamp01((S.elevDeg + 4.0) / 8.0);

      var keyDir = S.dir.clone();
      moonDir.set(-S.dir.x, Math.abs(S.dir.y) * 0.8 + 0.22, -S.dir.z).normalize();
      if (night > 0) keyDir.lerp(moonDir, night).normalize();
      sun.position.copy(keyDir).multiplyScalar(1500).add(new T.Vector3(-40, 30, -120));
      sun.color.copy(pal.light);
      sun.intensity = pal.lightI;
      hemi.color.copy(pal.zenith).lerp(new T.Color(1,1,1), 0.20); hemi.groundColor.copy(pal.amb).lerp(pal.haze, 0.28);
      hemi.intensity = pal.ambI;
      fill.intensity = K.lerp(0.12, 0.85, 1 - night);
      bounce.intensity = K.lerp(0.04, 0.78, 1 - night) * K.lerp(1.0, 0.45, K.clamp01((S.elevDeg - 6) / 30));
      bounce.color.copy(pal.haze).lerp(new T.Color(1, 1, 1), 0.45);
      fill.color.copy(pal.zenith).lerp(new T.Color(1,1,1), 0.30);

      fog.color.copy(pal.haze).lerp(pal.zenith, 0.34); fog.density = pal.fogD;

      skyU.uSunDir.value.copy(S.dir);
      skyU.uMoonDir.value.copy(moonDir);
      skyU.uZenith.value.copy(pal.zenith); skyU.uMid.value.copy(pal.mid); skyU.uHorizon.value.copy(pal.horizon);
      skyU.uHaze.value.copy(pal.haze); skyU.uGlow.value.copy(pal.glow);
      skyU.uDisc.value.copy(pal.disc);
      skyU.uNight.value = night; skyU.uSunUp.value = sunUp;

      watU.uSunDir.value.copy(S.dir);
      watU.uZenith.value.copy(pal.zenith); watU.uMid.value.copy(pal.mid); watU.uHorizon.value.copy(pal.horizon);
      watU.uHaze.value.copy(pal.haze); watU.uGlow.value.copy(pal.glow);
      watU.uDisc.value.copy(pal.disc); watU.uFogCol.value.copy(pal.haze).lerp(pal.zenith, 0.34);
      watU.uFogD.value = pal.fogD; watU.uNight.value = night; watU.uSunUp.value = sunUp;
      watU.uDeep.value.copy(K.C('#132420')).lerp(pal.haze, 0.02).multiplyScalar(K.lerp(1.0, 0.30, night));
      watU.uShallow.value.copy(K.C('#27423a')).lerp(pal.haze, 0.04).multiplyScalar(K.lerp(1.0, 0.26, night));

      // interior + street lighting swells after dusk
      var lampOn = K.clamp01((-S.elevDeg - 1.2) / 6.0);
      var warmDay = 0.055;
      matWarm.color.setScalar(K.lerp(warmDay, 1.0, lampOn));
      matWarm.color.multiply(new T.Color(1.0, 0.80, 0.52));
      matWarm.color.multiplyScalar(K.lerp(1.0, 2.3, lampOn));

      // glass picks up the sky so it never reads as a black hole
      matGlass.emissive.copy(pal.mid).multiplyScalar(K.lerp(0.42, 0.10, night));
      matGlass.color.copy(pal.zenith).lerp(new T.Color(1, 1, 1), 0.55);

      // grading
      var exp = K.lerp(1.14, 0.86, K.clamp01((S.elevDeg - 2) / 30)) * K.lerp(1.0, 2.1, night);
      if (post) {
        var cu = post.mComp.uniforms;
        cu.uExp.value = exp;
        cu.uBloom.value = K.lerp(0.30, 0.60, sunUp) * K.lerp(1.0, 1.6, night);
        cu.uSat.value = K.lerp(0.88, 1.02, 1 - night);
        cu.uLift.value = K.lerp(0.2, 0.9, night);
        cu.uVig.value = 0.40;
        cu.uCon.value = K.lerp(1.045, 1.00, night);
        var tint = new T.Color().copy(pal.light).lerp(new T.Color(1, 1, 1), 0.84);
        cu.uTint.value.set(tint.r, tint.g, tint.b);
      } else {
        // ACES darkens midtones vs the custom comp; lift exposure a touch
        renderer.toneMappingExposure = exp * 1.25;
      }
      skyU.uExposure.value = 1.0;
      return S;
    }

    /* ---------------------------------------------------------- animation */
    var clock = new T.Clock();
    var elapsed = 0, raf = 0, running = true;
    var tmpM = new T.Matrix4(), tmpQ = new T.Quaternion(), tmpV = new T.Vector3(), tmpS = new T.Vector3();
    var pathCurve = global.__pathCurve;

    function nowHours() {
      var d = new Date();
      return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
    }

    function updatePeople(dt) {
      var im = people.mesh;
      for (var i = 0; i < people.length; i++) {
        var p = people[i];
        p.t += p.speed * dt * 0.06;
        if (p.t > 1) p.t -= 1; if (p.t < 0) p.t += 1;
        var x, y, z, ang;
        if (p.onPath) {
          var pt = pathCurve.getPoint(p.t), tg = pathCurve.getTangent(p.t);
          x = pt.x - tg.z * p.lat * 0.35; z = pt.z + tg.x * p.lat * 0.35;
          y = terrainH(x, z) + 0.4;
          ang = Math.atan2(tg.x, tg.z) * (p.speed > 0 ? 1 : -1);
        } else {
          var zz = K.lerp(230, -560, p.t);
          x = W.promX(zz) + p.lat; z = zz;
          y = P.promY(zz) + 0.05;
          ang = p.speed > 0 ? 0 : Math.PI;
        }
        var bob = Math.sin(elapsed * 6.5 + p.ph) * 0.045;
        tmpV.set(x, y + bob, z);
        tmpQ.setFromEuler(new T.Euler(0, ang, Math.sin(elapsed * 6.5 + p.ph) * 0.035));
        tmpS.set(p.scale, p.scale, p.scale);
        tmpM.compose(tmpV, tmpQ, tmpS);
        im.setMatrixAt(i, tmpM);
      }
      im.instanceMatrix.needsUpdate = true;
    }

    function updateBirds(dt) {
      var im = birds.mesh;
      for (var i = 0; i < birds.length; i++) {
        var b2 = birds[i];
        b2.a += dt * 0.06;
        b2.x -= Math.cos(b2.a) * b2.sp * dt * 0.6;
        b2.z += Math.sin(b2.a * 0.7) * b2.sp * dt * 0.25;
        b2.y += Math.sin(elapsed * 0.7 + b2.ph) * dt * 2.2;
        if (b2.x < 120) b2.x = 980;
        var flap = 0.55 + Math.sin(elapsed * 7.5 + b2.ph) * 0.45;
        tmpV.set(b2.x, b2.y, b2.z);
        tmpQ.setFromEuler(new T.Euler(0, Math.atan2(-1, 0.2), flap * 0.4));
        tmpS.set(b2.s, b2.s * flap, b2.s);
        tmpM.compose(tmpV, tmpQ, tmpS);
        im.setMatrixAt(i, tmpM);
      }
      im.instanceMatrix.needsUpdate = true;
    }

    var api = {
      three: T, scene: scene, camera: camera, renderer: renderer,
      setTime: function (h) { state.hours = ((h % 24) + 24) % 24; state.auto = false; applyTime(state.hours); },
      useClock: function () { state.auto = true; },
      getTime: function () { return state.hours; },
      setSpeed: function (s) { state.speed = s; state.auto = false; },
      camera_: CAM,
      resize: resize,
      pause: function () { running = false; cancelAnimationFrame(raf); },
      resume: function () { if (running) return; running = true; clock.getDelta(); loop(); },
      isRunning: function () { return running; },
      // dt (seconds) advances the animation clock between stills, so
      // periodic re-renders show moved water/birds instead of a freeze.
      renderOnce: function (dt) { if (dt) elapsed += dt; frame(dt || 0); },
      dispose: function () {
        running = false; cancelAnimationFrame(raf);
        if (ro) ro.disconnect();
        global.removeEventListener('resize', resize);
        renderer.dispose();
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };

    function frame(dt) {
      if (state.auto) state.hours = nowHours();
      else if (state.speed) state.hours = (state.hours + state.speed * dt / 60) % 24;
      applyTime(state.hours);
      skyU.uTime.value = elapsed;
      watU.uTime.value = elapsed;
      updatePeople(dt); updateBirds(dt);
      sky.position.copy(camera.position);
      if (post) {
        post.mComp.uniforms.uTime.value = elapsed;
        renderer.setRenderTarget(post.scene);
        renderer.clear();
        renderer.render(scene, camera);
        var s = currentSize(), d = renderer.getPixelRatio();
        post.render(Math.floor(s[0] * d), Math.floor(s[1] * d));
      } else {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
      }
      if (api.onFrame) api.onFrame();
    }

    var minFrameMs = opts.fpsCap ? 1000 / opts.fpsCap : 0;
    var lastFrameAt = 0;
    function loop() {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      if (minFrameMs) {
        var nowMs = performance.now();
        if (nowMs - lastFrameAt < minFrameMs) return;
        lastFrameAt = nowMs;
      }
      var dt = Math.min(clock.getDelta(), 0.1);
      elapsed += dt;
      frame(dt);
    }
    applyTime(state.auto ? nowHours() : state.hours);
    if (opts.autoStart === false) { frame(0); } else { loop(); }
    return api;
  }

  global.ValleyScene.mount = mount;
})(window);
