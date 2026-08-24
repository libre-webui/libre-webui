/*
 * Libre Work Computer living landscape.
 *
 * The supplied artwork remains an exact CSS-backed scene plate while Three.js
 * adds clock-driven atmosphere, celestial light, water movement, stars,
 * window light, birds, and garden particles. The same PNG therefore remains a
 * complete fallback when WebGL is unavailable.
 */
(() => {
  'use strict';

  const THREE = window.THREE;
  const canvas = document.getElementById('landscape');
  const stateLabel = document.getElementById('scene-state');
  const shade = document.querySelector('.scene-shade');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  if (!THREE || !canvas) return;

  const IMAGE_ASPECT = 1280 / 800;
  const IMAGE_SIZE = new THREE.Vector2(1280, 800);
  const BAKED_SUN_UV = new THREE.Vector2(706 / 1280, 1 - 250 / 800);
  const TAU = Math.PI * 2;

  const keyframes = [
    {
      hour: 0,
      top: '#07101c',
      horizon: '#172840',
      grade: [0.62, 0.74, 1.04],
      ground: [0.48, 0.6, 0.72],
      exposure: 0.43,
      saturation: 0.62,
      skyMix: 0.9,
      haze: 0.22,
      night: 1,
      reflection: 0.08,
      birds: 0,
    },
    {
      hour: 4.75,
      top: '#101d34',
      horizon: '#8b5558',
      grade: [0.72, 0.72, 0.92],
      ground: [0.54, 0.58, 0.68],
      exposure: 0.5,
      saturation: 0.7,
      skyMix: 0.82,
      haze: 0.38,
      night: 0.82,
      reflection: 0.12,
      birds: 0,
    },
    {
      hour: 6.25,
      top: '#7189a4',
      horizon: '#f1a06f',
      grade: [1.02, 0.82, 0.74],
      ground: [0.76, 0.72, 0.64],
      exposure: 0.76,
      saturation: 0.88,
      skyMix: 0.56,
      haze: 0.54,
      night: 0.2,
      reflection: 0.42,
      birds: 0.42,
    },
    {
      hour: 8.5,
      top: '#8cb4d0',
      horizon: '#f2d1a6',
      grade: [1.02, 0.98, 0.9],
      ground: [0.92, 0.96, 0.82],
      exposure: 1.02,
      saturation: 0.96,
      skyMix: 0.38,
      haze: 0.4,
      night: 0,
      reflection: 0.5,
      birds: 0.9,
    },
    {
      hour: 12.5,
      top: '#78abd0',
      horizon: '#dce8ec',
      grade: [0.96, 1.02, 1.1],
      ground: [1, 1.04, 0.91],
      exposure: 1.14,
      saturation: 0.9,
      skyMix: 0.48,
      haze: 0.34,
      night: 0,
      reflection: 0.58,
      birds: 1,
    },
    {
      hour: 16.25,
      top: '#91a9bd',
      horizon: '#efc08d',
      grade: [1.04, 0.98, 0.84],
      ground: [1.02, 0.96, 0.79],
      exposure: 1.08,
      saturation: 0.98,
      skyMix: 0.28,
      haze: 0.46,
      night: 0,
      reflection: 0.76,
      birds: 1,
    },
    {
      hour: 18.25,
      top: '#aebbc4',
      horizon: '#f3bb7d',
      grade: [1, 1, 1],
      ground: [1, 1, 1],
      exposure: 1,
      saturation: 1,
      skyMix: 0.035,
      haze: 0.48,
      night: 0,
      reflection: 1,
      birds: 0.82,
    },
    {
      hour: 20.5,
      top: '#283951',
      horizon: '#c96a63',
      grade: [0.78, 0.7, 0.82],
      ground: [0.58, 0.6, 0.65],
      exposure: 0.58,
      saturation: 0.78,
      skyMix: 0.76,
      haze: 0.4,
      night: 0.68,
      reflection: 0.18,
      birds: 0.08,
    },
    {
      hour: 24,
      top: '#07101c',
      horizon: '#172840',
      grade: [0.62, 0.74, 1.04],
      ground: [0.48, 0.6, 0.72],
      exposure: 0.43,
      saturation: 0.62,
      skyMix: 0.9,
      haze: 0.22,
      night: 1,
      reflection: 0.08,
      birds: 0,
    },
  ];

  const clamp01 = value => Math.min(1, Math.max(0, value));
  const lerp = (from, to, amount) => from + (to - from) * amount;
  const smoothstep = (from, to, value) => {
    const amount = clamp01((value - from) / (to - from));
    return amount * amount * (3 - 2 * amount);
  };
  const random = (() => {
    let seed = 0x7f4a7c15;
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  })();

  const samplePalette = hour => {
    let lower = keyframes[0];
    let upper = keyframes[keyframes.length - 1];
    for (let index = 0; index < keyframes.length - 1; index += 1) {
      if (hour >= keyframes[index].hour && hour <= keyframes[index + 1].hour) {
        lower = keyframes[index];
        upper = keyframes[index + 1];
        break;
      }
    }
    const amount = smoothstep(lower.hour, upper.hour, hour);
    return {
      top: new THREE.Color(lower.top).lerp(new THREE.Color(upper.top), amount),
      horizon: new THREE.Color(lower.horizon).lerp(
        new THREE.Color(upper.horizon),
        amount
      ),
      grade: new THREE.Vector3(
        lerp(lower.grade[0], upper.grade[0], amount),
        lerp(lower.grade[1], upper.grade[1], amount),
        lerp(lower.grade[2], upper.grade[2], amount)
      ),
      ground: new THREE.Vector3(
        lerp(lower.ground[0], upper.ground[0], amount),
        lerp(lower.ground[1], upper.ground[1], amount),
        lerp(lower.ground[2], upper.ground[2], amount)
      ),
      exposure: lerp(lower.exposure, upper.exposure, amount),
      saturation: lerp(lower.saturation, upper.saturation, amount),
      skyMix: lerp(lower.skyMix, upper.skyMix, amount),
      haze: lerp(lower.haze, upper.haze, amount),
      night: lerp(lower.night, upper.night, amount),
      reflection: lerp(lower.reflection, upper.reflection, amount),
      birds: lerp(lower.birds, upper.birds, amount),
    };
  };

  const phaseForHour = hour => {
    if (hour < 5) return 'Night garden';
    if (hour < 7.5) return 'Dawn garden';
    if (hour < 11) return 'Morning garden';
    if (hour < 16) return 'Day garden';
    if (hour < 19.25) return 'Golden garden';
    if (hour < 21) return 'Twilight garden';
    return 'Night garden';
  };

  const makeRadialTexture = (solidUntil, fadeFrom) => {
    const textureCanvas = document.createElement('canvas');
    textureCanvas.width = 128;
    textureCanvas.height = 128;
    const context = textureCanvas.getContext('2d');
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(solidUntil, 'rgba(255,255,255,1)');
    gradient.addColorStop(fadeFrom, 'rgba(255,255,255,.42)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  };

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      depth: false,
      powerPreference: 'low-power',
    });
  } catch (error) {
    console.info(
      'Living landscape unavailable; using the still wallpaper.',
      error
    );
    return;
  }

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
  camera.position.z = 5;

  const uniforms = {
    uTime: { value: 0 },
    uViewAspect: { value: 1 },
    uImageAspect: { value: IMAGE_ASPECT },
    uImageSize: { value: IMAGE_SIZE },
    uBakedSunUv: { value: BAKED_SUN_UV },
    uSkyTop: { value: new THREE.Color('#aebbc4') },
    uSkyHorizon: { value: new THREE.Color('#f3bb7d') },
    uGrade: { value: new THREE.Vector3(1, 1, 1) },
    uGround: { value: new THREE.Vector3(1, 1, 1) },
    uExposure: { value: 1 },
    uSaturation: { value: 1 },
    uSkyMix: { value: 0 },
    uHaze: { value: 0.4 },
    uNight: { value: 0 },
    uReflection: { value: 1 },
    uSunCover: { value: 0 },
  };

  const plateMaterial = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uViewAspect;
      uniform float uImageAspect;
      uniform vec2 uImageSize;
      uniform vec2 uBakedSunUv;
      uniform vec3 uSkyTop;
      uniform vec3 uSkyHorizon;
      uniform vec3 uGrade;
      uniform vec3 uGround;
      uniform float uExposure;
      uniform float uSaturation;
      uniform float uSkyMix;
      uniform float uHaze;
      uniform float uNight;
      uniform float uReflection;
      uniform float uSunCover;
      varying vec2 vUv;

      vec2 coverUv(vec2 screenUv) {
        vec2 imageUv = screenUv;
        if (uViewAspect > uImageAspect) {
          imageUv.y = .5 + (screenUv.y - .5) * (uImageAspect / uViewAspect);
        } else {
          imageUv.x = .5 + (screenUv.x - .5) * (uViewAspect / uImageAspect);
        }
        return imageUv;
      }

      float riverMask(vec2 uv) {
        float travel = clamp((.595 - uv.y) / .35, 0., 1.);
        float center = .542 + travel * .125 + sin(travel * 5.2) * .009;
        float width = mix(.012, .086, travel);
        float across = 1. - smoothstep(width * .35, width, abs(uv.x - center));
        return across * smoothstep(.235, .31, uv.y) * (1. - smoothstep(.59, .615, uv.y));
      }

      float ellipse(vec2 uv, vec2 center, vec2 radius) {
        return 1. - smoothstep(.64, 1., length((uv - center) / radius));
      }

      void addLayer(inout vec4 composite, vec3 color, float opacity) {
        float amount = clamp(opacity, 0., 1.);
        composite.rgb = color * amount + composite.rgb * (1. - amount);
        composite.a = amount + composite.a * (1. - amount);
      }

      void main() {
        vec2 uv = coverUv(vUv);
        float water = riverMask(uv);
        vec4 composite = vec4(0.);

        float bakedSun = 1. - smoothstep(
          18.,
          52.,
          length((uv - uBakedSunUv) * uImageSize)
        );
        float skyHeight = smoothstep(.53, .88, uv.y);
        float skyMask = skyHeight;
        vec3 sky = mix(uSkyHorizon, uSkyTop, smoothstep(.56, 1., uv.y));
        addLayer(composite, sky, skyMask * uSkyMix * .54);

        float gradeOpacity = min(.14, length(uGrade - vec3(1.)) * .11) * (1. - uNight * .5);
        addLayer(composite, clamp(uGrade, 0., 1.), gradeOpacity);
        addLayer(composite, vec3(1.), max(0., uExposure - 1.) * .22);
        addLayer(composite, vec3(.018, .046, .09), uNight * .48);

        float groundMask = 1. - smoothstep(.51, .68, uv.y);
        float groundGrade = groundMask * (uNight * .18 + abs(1. - uExposure) * .12);
        addLayer(composite, uGround, groundGrade);

        float horizonHaze = exp(-pow((uv.y - .575) * 13., 2.)) * uHaze;
        addLayer(composite, uSkyHorizon, horizonHaze * .14);

        addLayer(composite, sky, bakedSun * uSunCover * .98);

        float riverTravel = clamp((.595 - uv.y) / .35, 0., 1.);
        float riverCenter = .542 + riverTravel * .125 + sin(riverTravel * 5.2) * .009;
        float reflectionCore = exp(-pow((uv.x - riverCenter) * 72., 2.));
        float brokenLight = pow(.5 + .5 * sin(uv.y * 470. + uTime * 1.5), 8.);
        float glint = water * reflectionCore * (0.3 + brokenLight * .95) * uReflection;
        addLayer(composite, vec3(1., .61, .27), glint * .52);
        addLayer(composite, vec3(.025, .09, .14), water * uNight * .42);

        float windowLight = 0.;
        windowLight += ellipse(uv, vec2(.224, .619), vec2(.027, .047));
        windowLight += ellipse(uv, vec2(.196, .491), vec2(.063, .032)) * .72;
        windowLight += ellipse(uv, vec2(.837, .603), vec2(.037, .046)) * .78;
        windowLight += ellipse(uv, vec2(.929, .569), vec2(.052, .011)) * .42;
        addLayer(composite, vec3(1., .43, .12), windowLight * uNight * .3);

        vec3 color = composite.a > .0001 ? composite.rgb / composite.a : vec3(0.);
        gl_FragColor = vec4(max(color, vec3(0.)), composite.a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const plate = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), plateMaterial);
  plate.renderOrder = 0;
  scene.add(plate);

  const discTexture = makeRadialTexture(0.28, 0.42);
  const glowTexture = makeRadialTexture(0, 0.16);
  const pointTexture = makeRadialTexture(0.02, 0.24);

  const makeSprite = (texture, color, blending = THREE.NormalBlending) => {
    const material = new THREE.SpriteMaterial({
      map: texture,
      color,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending,
      opacity: 0,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.z = 1;
    scene.add(sprite);
    return sprite;
  };

  const sunGlow = makeSprite(glowTexture, '#ffb057', THREE.AdditiveBlending);
  const sun = makeSprite(discTexture, '#fff7d5', THREE.AdditiveBlending);
  const moonGlow = makeSprite(glowTexture, '#82a9d8', THREE.AdditiveBlending);
  const moon = makeSprite(discTexture, '#dce9f7');
  sun.scale.setScalar(0.105);
  sunGlow.scale.setScalar(0.48);
  moon.scale.setScalar(0.078);
  moonGlow.scale.setScalar(0.34);

  const starData = Array.from({ length: 110 }, () => ({
    u: 0.04 + random() * 0.92,
    v: 0.61 + random() * 0.36,
    brightness: 0.35 + random() * 0.65,
  }));
  const starPositions = new Float32Array(starData.length * 3);
  const starColors = new Float32Array(starData.length * 3);
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(starPositions, 3)
  );
  starGeometry.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
  starData.forEach((star, index) => {
    starColors[index * 3] = 0.7 * star.brightness;
    starColors[index * 3 + 1] = 0.82 * star.brightness;
    starColors[index * 3 + 2] = star.brightness;
  });
  const starMaterial = new THREE.PointsMaterial({
    size: 1.65,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
  });
  const stars = new THREE.Points(starGeometry, starMaterial);
  stars.position.z = 1.2;
  scene.add(stars);

  const birdData = Array.from({ length: 22 }, () => ({
    u: 0.79 + random() * 0.19,
    v: 0.81 + random() * 0.16,
    size: 0.0035 + random() * 0.006,
    phase: random() * TAU,
  }));
  const birdPositions = new Float32Array(birdData.length * 12);
  const birdGeometry = new THREE.BufferGeometry();
  birdGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(birdPositions, 3)
  );
  const birdMaterial = new THREE.LineBasicMaterial({
    color: '#202720',
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
  });
  const birds = new THREE.LineSegments(birdGeometry, birdMaterial);
  birds.position.z = 1.25;
  scene.add(birds);

  const moteData = Array.from({ length: 58 }, () => ({
    u: 0.18 + random() * 0.78,
    v: 0.08 + random() * 0.39,
    phase: random() * TAU,
  }));
  const motePositions = new Float32Array(moteData.length * 3);
  const moteGeometry = new THREE.BufferGeometry();
  moteGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(motePositions, 3)
  );
  const moteMaterial = new THREE.PointsMaterial({
    map: pointTexture,
    color: '#ffb15e',
    size: 4.2,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const motes = new THREE.Points(moteGeometry, moteMaterial);
  motes.position.z = 1.3;
  scene.add(motes);

  const pathLightUvs = Array.from({ length: 15 }, (_, index) => {
    const amount = index / 14;
    return {
      u: lerp(0.438, 0.496, amount) + Math.sin(index * 1.7) * 0.003,
      v: lerp(0.575, 0.302, amount),
    };
  });
  const pathLightPositions = new Float32Array(pathLightUvs.length * 3);
  const pathLightGeometry = new THREE.BufferGeometry();
  pathLightGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(pathLightPositions, 3)
  );
  const pathLightMaterial = new THREE.PointsMaterial({
    map: pointTexture,
    color: '#ffc06b',
    size: 6.5,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const pathLights = new THREE.Points(pathLightGeometry, pathLightMaterial);
  pathLights.position.z = 1.35;
  scene.add(pathLights);

  let aspect = 1;
  let activePalette = samplePalette(18.25);
  let lastTime = 0;
  let animationFrame = 0;
  let sceneReady = false;
  let contextAvailable = true;

  const screenUvToWorld = (u, v) => ({
    x: (u * 2 - 1) * aspect,
    y: v * 2 - 1,
  });

  const imageUvToScreenUv = (u, v) => {
    if (aspect > IMAGE_ASPECT) {
      return { u, v: 0.5 + (v - 0.5) / (IMAGE_ASPECT / aspect) };
    }
    return { u: 0.5 + (u - 0.5) / (aspect / IMAGE_ASPECT), v };
  };

  const imageUvToWorld = (u, v) => {
    const screenUv = imageUvToScreenUv(u, v);
    return screenUvToWorld(screenUv.u, screenUv.v);
  };

  const updateStaticPositions = () => {
    starData.forEach((star, index) => {
      const world = screenUvToWorld(star.u, star.v);
      starPositions[index * 3] = world.x;
      starPositions[index * 3 + 1] = world.y;
      starPositions[index * 3 + 2] = 0;
    });
    starGeometry.attributes.position.needsUpdate = true;

    moteData.forEach((mote, index) => {
      const world = screenUvToWorld(mote.u, mote.v);
      motePositions[index * 3] = world.x;
      motePositions[index * 3 + 1] = world.y;
      motePositions[index * 3 + 2] = 0;
    });
    moteGeometry.attributes.position.needsUpdate = true;

    pathLightUvs.forEach((light, index) => {
      const world = imageUvToWorld(light.u, light.v);
      pathLightPositions[index * 3] = world.x;
      pathLightPositions[index * 3 + 1] = world.y;
      pathLightPositions[index * 3 + 2] = 0;
    });
    pathLightGeometry.attributes.position.needsUpdate = true;
  };

  const updateBirds = seconds => {
    birdData.forEach((bird, index) => {
      const flap = 0.45 + Math.sin(seconds * 2.1 + bird.phase) * 0.24;
      const left = screenUvToWorld(
        bird.u - bird.size,
        bird.v + bird.size * flap
      );
      const center = screenUvToWorld(bird.u, bird.v);
      const right = screenUvToWorld(
        bird.u + bird.size,
        bird.v + bird.size * flap
      );
      const offset = index * 12;
      birdPositions[offset] = left.x;
      birdPositions[offset + 1] = left.y;
      birdPositions[offset + 2] = 0;
      birdPositions[offset + 3] = center.x;
      birdPositions[offset + 4] = center.y;
      birdPositions[offset + 5] = 0;
      birdPositions[offset + 6] = center.x;
      birdPositions[offset + 7] = center.y;
      birdPositions[offset + 8] = 0;
      birdPositions[offset + 9] = right.x;
      birdPositions[offset + 10] = right.y;
      birdPositions[offset + 11] = 0;
    });
    birdGeometry.attributes.position.needsUpdate = true;
  };

  const positionCelestialBodies = hour => {
    const sunProgress = clamp01((hour - 5.75) / 12.5);
    const sunUv = {
      u: lerp(0.38, BAKED_SUN_UV.x, sunProgress),
      v: BAKED_SUN_UV.y + Math.sin(sunProgress * Math.PI) * 0.24,
    };
    const sunWorld = imageUvToWorld(sunUv.u, sunUv.v);
    sun.position.set(sunWorld.x, sunWorld.y, 1);
    sunGlow.position.set(sunWorld.x, sunWorld.y, 0.95);

    const daylight =
      smoothstep(5.45, 6.15, hour) * (1 - smoothstep(18.2, 19.15, hour));
    sun.material.opacity = daylight;
    sunGlow.material.opacity =
      daylight * lerp(0.3, 0.64, activePalette.reflection);

    const nightHour = hour >= 18.75 ? hour - 18.75 : hour + 5.25;
    const moonProgress = clamp01(nightHour / 11.5);
    const moonUv = {
      u: lerp(0.34, 0.67, moonProgress),
      v: 0.7 + Math.sin(moonProgress * Math.PI) * 0.19,
    };
    const moonWorld = imageUvToWorld(moonUv.u, moonUv.v);
    moon.position.set(moonWorld.x, moonWorld.y, 1);
    moonGlow.position.set(moonWorld.x, moonWorld.y, 0.95);
    const moonlight = activePalette.night * (1 - daylight * 0.85);
    moon.material.opacity = moonlight * 0.88;
    moonGlow.material.opacity = moonlight * 0.3;

    if (shade) {
      const activeUv =
        daylight > 0.2
          ? imageUvToScreenUv(sunUv.u, sunUv.v)
          : imageUvToScreenUv(moonUv.u, moonUv.v);
      const glowColor = daylight > 0.2 ? '255, 183, 102' : '124, 165, 212';
      const glowOpacity = daylight > 0.2 ? 0.07 : 0.045;
      shade.style.background = `
        radial-gradient(circle at ${activeUv.u * 100}% ${(1 - activeUv.v) * 100}%, rgba(${glowColor}, ${glowOpacity}), transparent 30%),
        linear-gradient(100deg, rgba(5, 5, 6, .88) 0%, rgba(5, 5, 6, .66) 40%, rgba(5, 5, 6, .22) 72%, rgba(5, 5, 6, .06) 100%)
      `;
    }
  };

  const updateTime = date => {
    const now =
      date instanceof Date ? date : window.getLibreNow?.() || new Date();
    const hour =
      now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
    activePalette = samplePalette(hour);
    uniforms.uSkyTop.value.copy(activePalette.top);
    uniforms.uSkyHorizon.value.copy(activePalette.horizon);
    uniforms.uGrade.value.copy(activePalette.grade);
    uniforms.uGround.value.copy(activePalette.ground);
    uniforms.uExposure.value = activePalette.exposure;
    uniforms.uSaturation.value = activePalette.saturation;
    uniforms.uSkyMix.value = activePalette.skyMix;
    uniforms.uHaze.value = activePalette.haze;
    uniforms.uNight.value = activePalette.night;
    uniforms.uReflection.value = activePalette.reflection;
    uniforms.uSunCover.value = smoothstep(0.12, 1.25, Math.abs(hour - 18.25));
    starMaterial.opacity = activePalette.night * 0.88;
    birdMaterial.opacity = activePalette.birds * 0.72;
    moteMaterial.opacity = Math.max(
      activePalette.night * 0.52,
      activePalette.reflection * 0.13
    );
    pathLightMaterial.opacity = activePalette.night * 0.8;
    positionCelestialBodies(hour);

    if (stateLabel) {
      stateLabel.textContent = `Libre / Work Computer — ${phaseForHour(hour)}`;
    }
    window.__libreLandscape = {
      ready: sceneReady && contextAvailable,
      hour,
      phase: phaseForHour(hour),
      renderer: `Three.js r${THREE.REVISION}`,
      webgl: renderer.capabilities.isWebGL2 ? 'WebGL 2' : 'WebGL 1',
      drawCalls: renderer.info.render.calls,
    };
  };

  const resize = () => {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    aspect = width / height;
    renderer.setSize(width, height, false);
    camera.left = -aspect;
    camera.right = aspect;
    camera.top = 1;
    camera.bottom = -1;
    camera.updateProjectionMatrix();
    plate.scale.set(aspect, 1, 1);
    uniforms.uViewAspect.value = aspect;
    updateStaticPositions();
    updateBirds(uniforms.uTime.value);
    updateTime();
    if (sceneReady) renderer.render(scene, camera);
  };

  const render = milliseconds => {
    animationFrame = requestAnimationFrame(render);
    if (!sceneReady || !contextAvailable || document.hidden) return;
    if (milliseconds - lastTime < 42) return;
    lastTime = milliseconds;
    const seconds = milliseconds / 1000;
    uniforms.uTime.value = seconds;
    updateBirds(seconds);
    motes.position.y = Math.sin(seconds * 0.2) * 0.006;
    stars.material.opacity =
      activePalette.night * (0.78 + Math.sin(seconds * 0.32) * 0.08);
    renderer.render(scene, camera);
  };

  const startAnimation = () => {
    cancelAnimationFrame(animationFrame);
    if (reducedMotion.matches) {
      uniforms.uTime.value = 0;
      updateBirds(0);
      if (sceneReady) renderer.render(scene, camera);
      return;
    }
    animationFrame = requestAnimationFrame(render);
  };

  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    contextAvailable = false;
    document.body.classList.remove('webgl-ready');
    window.__libreLandscape = { ready: false, reason: 'context-lost' };
  });
  canvas.addEventListener('webglcontextrestored', () => {
    contextAvailable = true;
    if (sceneReady) {
      renderer.render(scene, camera);
      document.body.classList.add('webgl-ready');
      updateTime();
      startAnimation();
    }
  });

  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('libre-time', event => {
    updateTime(event.detail);
    if (reducedMotion.matches && sceneReady) renderer.render(scene, camera);
  });
  reducedMotion.addEventListener?.('change', startAnimation);

  resize();
  updateTime();
  try {
    renderer.compile(scene, camera);
    renderer.render(scene, camera);
    sceneReady = true;
    document.body.classList.add('webgl-ready');
    updateTime();
    startAnimation();
  } catch (error) {
    console.info(
      'Living landscape unavailable; using the still wallpaper.',
      error
    );
    renderer.dispose();
    window.__libreLandscape = { ready: false, reason: 'render-unavailable' };
  }
})();
