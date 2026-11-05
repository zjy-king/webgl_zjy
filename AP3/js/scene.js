/* ==========================================================================
 * scene.js  ——  几何体生成 + 场景对象描述
 * --------------------------------------------------------------------------
 * 本文件只负责「有什么物体、长什么样、放在哪」，
 * 不接触任何 GL 状态。几何体以纯数组形式返回，由 gl.js 上传成 VAO。
 *
 * 坐标约定：
 *   Y 轴向上，房间尺寸 12(x) × 9(y) × 14(z)，
 *   地面 y = 0，房间中心在 xz 平面的原点。
 * ========================================================================== */
'use strict';

/* --------------------------------------------------------------------------
 * 几何体生成器
 * 每个生成器统一返回 { pos, nrm, uv, idx }，索引为 Uint32Array。
 * 所有几何体都是「单位大小」，实际尺寸由模型矩阵的 scale 决定，
 * 这样 GPU 上只需一份顶点数据，缩放不会产生新 buffer。
 * -------------------------------------------------------------------------- */

/* 球体（经纬细分），半径 0.5（单位直径，便于用 scale 当直径用） */
function createSphere(subdiv){
  const pos = [], nrm = [], uv = [], idx = [];
  for(let lat = 0; lat <= subdiv; lat++){
    const theta = Math.PI * lat / subdiv;
    const st = Math.sin(theta), ct = Math.cos(theta);
    for(let lon = 0; lon <= subdiv; lon++){
      const phi = 2 * Math.PI * lon / subdiv;
      const x = st * Math.cos(phi) * 0.5;
      const y = ct * 0.5;
      const z = st * Math.sin(phi) * 0.5;
      pos.push(x, y, z);
      /* 球面法线就是归一化的位置方向 */
      nrm.push(x * 2, y * 2, z * 2);
      uv.push(lon / subdiv, 1 - lat / subdiv);
    }
  }
  for(let lat = 0; lat < subdiv; lat++){
    for(let lon = 0; lon < subdiv; lon++){
      const a = lat * (subdiv + 1) + lon;
      const b = a + 1;
      const c = (lat + 1) * (subdiv + 1) + lon;
      const d = c + 1;
      idx.push(a, c, b,  b, c, d);
    }
  }
  return pack(pos, nrm, uv, idx);
}

/* 立方体，边长 1，中心在原点。每个面独立 4 个顶点（保证法线不平滑） */
function createCube(){
  const f = [
    /* dir, u, v  —— 每个面用一个 3 元组基底定义 4 个角点 */
    { n:[ 0, 0, 1], u:[1, 0, 0], v:[0, 1, 0] },  // +Z
    { n:[ 0, 0,-1], u:[-1,0, 0], v:[0, 1, 0] },  // -Z
    { n:[ 1, 0, 0], u:[0, 0,-1], v:[0, 1, 0] },  // +X
    { n:[-1, 0, 0], u:[0, 0, 1], v:[0, 1, 0] },  // -X
    { n:[ 0, 1, 0], u:[1, 0, 0], v:[0, 0,-1] },  // +Y
    { n:[ 0,-1, 0], u:[1, 0, 0], v:[0, 0, 1] },  // -Y
  ];
  const pos = [], nrm = [], uv = [], idx = [];
  f.forEach(function(face, k){
    const b = k * 4;
    /* 四个角：(−u,−v) (+u,−v) (+u,+v) (−u,+v)，都在 ±0.5 上 */
    const corners = [[-1,-1],[1,-1],[1,1],[-1,1]];
    corners.forEach(function(c){
      pos.push(
        face.n[0]*0.5 + face.u[0]*c[0]*0.5 + face.v[0]*c[1]*0.5,
        face.n[1]*0.5 + face.u[1]*c[0]*0.5 + face.v[1]*c[1]*0.5,
        face.n[2]*0.5 + face.u[2]*c[0]*0.5 + face.v[2]*c[1]*0.5
      );
      nrm.push(face.n[0], face.n[1], face.n[2]);
      uv.push((c[0] + 1) * 0.5, (c[1] + 1) * 0.5);
    });
    idx.push(b, b+1, b+2,  b, b+2, b+3);
  });
  return pack(pos, nrm, uv, idx);
}

/* 圆柱（含上下底），高 1、半径 0.5，轴沿 Y */
function createCylinder(segs){
  const pos = [], nrm = [], uv = [], idx = [];
  /* ---- 侧面 ---- */
  const sideBase = 0;
  for(let i = 0; i <= segs; i++){
    const a = 2 * Math.PI * i / segs;
    const cx = Math.cos(a), cz = Math.sin(a);
    /* 上沿 */
    pos.push(cx * 0.5,  0.5, cz * 0.5);
    nrm.push(cx, 0, cz);
    uv.push(i / segs, 1);
    /* 下沿 */
    pos.push(cx * 0.5, -0.5, cz * 0.5);
    nrm.push(cx, 0, cz);
    uv.push(i / segs, 0);
  }
  for(let i = 0; i < segs; i++){
    const a = sideBase + i * 2;
    idx.push(a, a+2, a+1,  a+1, a+2, a+3);
  }
  /* ---- 顶盖 ---- */
  const topCenter = pos.length / 3;
  pos.push(0, 0.5, 0); nrm.push(0, 1, 0); uv.push(0.5, 0.5);
  const topStart = pos.length / 3;
  for(let i = 0; i <= segs; i++){
    const a = 2 * Math.PI * i / segs;
    pos.push(Math.cos(a) * 0.5, 0.5, Math.sin(a) * 0.5);
    nrm.push(0, 1, 0);
    uv.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
  }
  /* 【绕序要和写死的法线 (0,1,0) 一致】
     环上的点按 a 递增排列，从 +y 往下看（x 右、z 上）就是逆时针。
     顶盖要正面朝上，三角形必须是 (中心, 下一个点, 当前点)，
     写成 (中心, 当前点, 下一个点) 的话几何法线朝下，
     开背面剔除后整张顶盖被剔掉 —— 圆柱就成了一个敞口的空管。 */
  for(let i = 0; i < segs; i++) idx.push(topCenter, topStart + i + 1, topStart + i);

  /* ---- 底盖 ---- */
  const botCenter = pos.length / 3;
  pos.push(0, -0.5, 0); nrm.push(0, -1, 0); uv.push(0.5, 0.5);
  const botStart = pos.length / 3;
  for(let i = 0; i <= segs; i++){
    const a = 2 * Math.PI * i / segs;
    pos.push(Math.cos(a) * 0.5, -0.5, Math.sin(a) * 0.5);
    nrm.push(0, -1, 0);
    uv.push(0.5 + Math.cos(a) * 0.5, 0.5 - Math.sin(a) * 0.5);
  }
  /* 底盖同理：法线 (0,-1,0)，从下方看才是逆时针，所以顺序和顶盖相反 */
  for(let i = 0; i < segs; i++) idx.push(botCenter, botStart + i, botStart + i + 1);

  return pack(pos, nrm, uv, idx);
}

/* 圆环（torus），外径 1、管径 0.28，环平面为 XZ */
function createTorus(segU, segV){
  const R = 0.42, r = 0.14;
  const pos = [], nrm = [], uv = [], idx = [];
  for(let i = 0; i <= segU; i++){
    const u = 2 * Math.PI * i / segU;
    const cu = Math.cos(u), su = Math.sin(u);
    for(let j = 0; j <= segV; j++){
      const v = 2 * Math.PI * j / segV;
      const cv = Math.cos(v), sv = Math.sin(v);
      /* 环心在 (R·cu, 0, R·su)，管截面朝外方向为 (cu, 0, su) */
      const nx = cv * cu, ny = sv, nz = cv * su;
      pos.push(R * cu + r * nx, r * ny, R * su + r * nz);
      nrm.push(nx, ny, nz);
      uv.push(i / segU, j / segV);
    }
  }
  for(let i = 0; i < segU; i++){
    for(let j = 0; j < segV; j++){
      const a = i * (segV + 1) + j;
      const b = a + 1;
      const c = (i + 1) * (segV + 1) + j;
      const d = c + 1;
      /* 【绕序必须与球体一致】
         参数化 (u 绕大圈, v 绕管截面) 得到的切线方向与球体不同，
         直接用球体那套 (a,c,b) 会让三角形法线朝内，
         开背面剔除后表现为「看到管子内壁」——圆环变成一个黑洞。
         这里交换成 (a,b,c)，与球体/圆柱的绕序统一为逆时针（外部可见）。 */
      idx.push(a, b, c,  b, d, c);
    }
  }
  return pack(pos, nrm, uv, idx);
}

/* 平面（XZ 面，法线 +Y），边长 1 */
function createPlane(subdiv){
  subdiv = subdiv || 1;
  const pos = [], nrm = [], uv = [], idx = [];
  for(let i = 0; i <= subdiv; i++){
    for(let j = 0; j <= subdiv; j++){
      pos.push(i / subdiv - 0.5, 0, j / subdiv - 0.5);
      nrm.push(0, 1, 0);
      uv.push(i / subdiv, j / subdiv);
    }
  }
  for(let i = 0; i < subdiv; i++){
    for(let j = 0; j < subdiv; j++){
      const a = i * (subdiv + 1) + j;
      const b = a + 1;                      // +z
      const c = (i + 1) * (subdiv + 1) + j; // +x
      const d = c + 1;                      // +x +z
      /* 【绕序必须让 +y 面朝外】
         法线写的是 (0,1,0)，三角形绕序就必须和它一致（右手定则）。
         从 +y 往下看、x 向右、z 向上时，a→b→c 是逆时针，正面朝上；
         写成 a→c→b 就是顺时针，正面朝下 —— 开背面剔除后整块地板被剔掉，
         画面上只剩天空盒的底面，看起来「地板变成了一面蓝灰色玻璃」。
         之前地板一直是这个症状，根因就在这里。 */
      idx.push(a, b, c,  b, d, c);
    }
  }
  return pack(pos, nrm, uv, idx);
}

/* 长方体（可指定尺寸比），复用立方体但顶点按尺寸展开，
   用于墙、桌子这类非立方体。生成时直接给最终尺寸，不再靠 scale。 */
function createBox(sx, sy, sz){
  const c = createCube();
  const pos = new Float32Array(c.pos.length);
  for(let i = 0; i < c.pos.length; i += 3){
    pos[i]   = c.pos[i]   * sx;
    pos[i+1] = c.pos[i+1] * sy;
    pos[i+2] = c.pos[i+2] * sz;
  }
  return { pos: pos, nrm: c.nrm, uv: c.uv, idx: c.idx };
}

function pack(pos, nrm, uv, idx){
  return {
    pos: new Float32Array(pos),
    nrm: new Float32Array(nrm),
    uv:  new Float32Array(uv),
    idx: new Uint32Array(idx)
  };
}

/* ==========================================================================
 * 场景定义
 * --------------------------------------------------------------------------
 * 每个物体字段说明：
 *   id       拾取用的唯一整数（写入 ID 颜色缓冲，必须 ≥ 1）
 *   name     界面显示名
 *   geo      几何体 key（见 main.js 的 GEO 表）
 *   pos/rot/scale  变换（rot 为欧拉角，单位度，顺序 XYZ）
 *   mat      材质参数（会被面板实时修改）
 *   pickable 是否参与拾取
 *   castShadow / receiveShadow  是否投影 / 接收阴影
 * ========================================================================== */

/* 默认材质：Phong 参数 */
function defaultMaterial(opt){
  opt = opt || {};
  return {
    ambient:   opt.ambient   !== undefined ? opt.ambient   : 0.25,
    diffuse:   opt.diffuse   !== undefined ? opt.diffuse   : [0.80, 0.78, 0.74],
    specular:  opt.specular  !== undefined ? opt.specular  : 0.60,
    shininess: opt.shininess !== undefined ? opt.shininess : 48,
    reflect:   opt.reflect   !== undefined ? opt.reflect   : 0.0,   // 环境贴图混合比例
    texKey:    opt.texKey    !== undefined ? opt.texKey    : null,
    /* UV 平铺倍数：几何体的 UV 默认是 [0,1]，
       但对一个「几米长的桌面」来说，一张贴图铺满会糊成一片。
       uvScale 让木纹重复几遍，看起来才是真正的木板。 */
    uvScale:   opt.uvScale   !== undefined ? opt.uvScale   : [1, 1],
    normalKey: opt.normalKey !== undefined ? opt.normalKey : null,  // E1
    normalStrength: opt.normalStrength !== undefined ? opt.normalStrength : 1.0,
    alpha:     opt.alpha     !== undefined ? opt.alpha     : 1.0,   // E2 透明
    toon:      opt.toon      !== undefined ? opt.toon      : false  // E3
  };
}

const ROOM = { w: 14, h: 9, d: 16 };

const SCENE = {
  objects: [
    /* ---------------- 房间结构（不参与拾取，但接收阴影） ---------------- */
    { id: 1, name: '地面', geo: 'planeBig', pickable: false,
      pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1],
      castShadow: false, receiveShadow: true,
      /* 【地面为什么要亮】
         阴影是否「看得见」取决于「全亮」和「阴影」两个状态的亮度差。
         如果地面本身就很暗（贴图灰 + kd 小），阴影只会让暗处更暗一点点，
         视觉上完全察觉不到。所以把地面 kd 提到接近白色，
         让全亮状态明显偏亮，阴影投上去才有对比。 */
      mat: defaultMaterial({ ambient: 0.62, diffuse: [1.35, 1.28, 1.18],
                             specular: 0.10, shininess: 8,
                             texKey: 'floor', uvScale: [3, 4] }) },

    { id: 2, name: '后墙', geo: 'box_wallBack', pickable: false,
      pos: [0, ROOM.h / 2, -ROOM.d / 2], rot: [0, 0, 0], scale: [1, 1, 1],
      castShadow: false, receiveShadow: true,
      /* shininess 太小时高光会摊成一大片白斑，墙面上很出戏；
         墙面本来也不该有强高光，ks 压到 0.02 基本只剩漫反射。 */
      mat: defaultMaterial({ ambient: 0.72, diffuse: [0.96, 0.94, 0.90],
                             specular: 0.02, shininess: 24 }) },

    /* 右墙放在 x = +w/2 处，相机在 yaw≈0.16 时看到的是它的内侧面。
       如果这里写成负值（左墙），相机就会落在墙外，画面被墙挡住。 */
    { id: 3, name: '右墙', geo: 'box_wallLeft', pickable: false,
      pos: [ROOM.w / 2, ROOM.h / 2, 0.4], rot: [0, 0, 0], scale: [1, 1, 1],
      castShadow: false, receiveShadow: true,
      mat: defaultMaterial({ ambient: 0.70, diffuse: [0.92, 0.90, 0.86],
                             specular: 0.02, shininess: 24 }) },

    /* ---------------- 桌面（可拾取，接收阴影） ----------------
       【记一个常量：桌面顶面高度 TABLE_TOP_Y = 2.05 + 0.28/2 = 2.19】
       放在桌面上的物体，y 必须等于「2.19 + 该物体的半高」，
       否则就是悬空或者陷进桌面里。后面每个物体的注释都标了怎么算的。 */
    { id: 4, name: '桌面', geo: 'box_tableTop', pickable: true,
      pos: [0, 2.05, 0.1], rot: [0, 0, 0], scale: [1, 1, 1],
      castShadow: true, receiveShadow: true,
      mat: defaultMaterial({ ambient: 0.40, diffuse: [0.98, 0.96, 0.94],
                             specular: 0.35, shininess: 30,
                             texKey: 'wood', uvScale: [3, 1.6] }) },

    /* 四条桌腿：高度 2.0，中心 y=1.0 → 上端 2.0（顶住桌面底部 1.91，略插入）、
       下端 0.0（正好落在地面上）。放在桌面内侧一点，视觉上才站得稳。 */
    { id: 5, name: '桌腿 A', geo: 'box_legA', pickable: true,
      pos: [-2.78, 1.0, -1.30], rot: [0, 0, 0], scale: [1, 1, 1],
      castShadow: true, receiveShadow: true,
      mat: defaultMaterial({ ambient: 0.62, diffuse: [0.82, 0.56, 0.36],
                             specular: 0.20, shininess: 16,
                             texKey: 'wood', uvScale: [1, 3] }) },

    { id: 6, name: '桌腿 B', geo: 'box_legA', pickable: true,
      pos: [ 2.78, 1.0, -1.30], rot: [0, 0, 0], scale: [1, 1, 1],
      castShadow: true, receiveShadow: true,
      mat: defaultMaterial({ ambient: 0.62, diffuse: [0.82, 0.56, 0.36],
                             specular: 0.20, shininess: 16,
                             texKey: 'wood', uvScale: [1, 3] }) },

    { id: 7, name: '桌腿 C', geo: 'box_legA', pickable: true,
      pos: [-2.78, 1.0, 1.50], rot: [0, 0, 0], scale: [1, 1, 1],
      castShadow: true, receiveShadow: true,
      mat: defaultMaterial({ ambient: 0.62, diffuse: [0.82, 0.56, 0.36],
                             specular: 0.20, shininess: 16,
                             texKey: 'wood', uvScale: [1, 3] }) },

    { id: 8, name: '桌腿 D', geo: 'box_legA', pickable: true,
      pos: [ 2.78, 1.0, 1.50], rot: [0, 0, 0], scale: [1, 1, 1],
      castShadow: true, receiveShadow: true,
      mat: defaultMaterial({ ambient: 0.62, diffuse: [0.82, 0.56, 0.36],
                             specular: 0.20, shininess: 16,
                             texKey: 'wood', uvScale: [1, 3] }) },

    /* ---------------- 5 个可拾取展示物体 ---------------- */

    /* ① 高反射镜面球：用 cubemap 环境贴图（要求 4）
       放在桌子最左侧，球面会映出窗户和灯光，最能体现环境贴图效果 */
    { id: 10, name: '镜面球', geo: 'sphere', pickable: true,
      /* 球半径 = 0.5 × 1.45 = 0.725，所以 y = 2.19 + 0.725 = 2.915 */
      pos: [-2.15, 2.915, -0.25], rot: [0, 0, 0], scale: [1.45, 1.45, 1.45],
      castShadow: true, receiveShadow: true,
      /* kd 极小 + 反射率极高 = 镜子。但 kd 也别真的给 0，
         否则「只开环境光」时它是一颗纯黑球，看起来像渲染坏了。 */
      mat: defaultMaterial({ ambient: 0.32, diffuse: [0.16, 0.17, 0.20],
                             specular: 1.0, shininess: 220, reflect: 0.92 }) },

    /* ② 木质立方体：普通位图纹理（要求 3）
       立方体每个面独立 UV，贴图能完整显示成一张「木箱正面」 */
    { id: 11, name: '纹理方块', geo: 'cube', pickable: true,
      /* 立方体半高 = 0.5 × 0.95 = 0.475，所以 y = 2.19 + 0.475 = 2.665 */
      pos: [2.25, 2.665, -0.35], rot: [0, -22, 0], scale: [0.95, 0.95, 0.95],
      castShadow: true, receiveShadow: true,
      /* ambient 不能太低：背光的那一面全靠它，低了就是一块死黑 */
      mat: defaultMaterial({ ambient: 0.68, diffuse: [0.95, 0.93, 0.90],
                             specular: 0.42, shininess: 42, texKey: 'crate' }) },

    /* ③ 圆柱：金属质感，光滑侧面 + 强高光，观察镜面分量的形状变化 */
    { id: 12, name: '金属圆柱', geo: 'cylinder', pickable: true,
      /* 圆柱高 1、y 方向放大 1.35，半高 = 0.675，所以 y = 2.19 + 0.675 = 2.865 */
      pos: [-0.15, 2.865, 0.30], rot: [0, 0, 0], scale: [0.75, 1.35, 0.75],
      castShadow: true, receiveShadow: true,
      mat: defaultMaterial({ ambient: 0.58, diffuse: [0.90, 0.92, 0.96],
                             specular: 0.95, shininess: 120, reflect: 0.22 }) },

    /* ④ 圆环：法线/凹凸贴图对比（E1）
       立起来放（绕 X 轴 90°），让有砖纹的表面正对相机 */
    { id: 13, name: '法线贴图环', geo: 'torus', pickable: true,
      /* 绕 X 轴立起来后，竖直方向的半高 = (R + r) × 1.35 = 0.56 × 1.35 = 0.756
         → y = 2.19 + 0.756 = 2.946 */
      pos: [0.95, 2.946, -0.75], rot: [90, 0, 0], scale: [1.35, 1.35, 1.35],
      castShadow: true, receiveShadow: true,
      mat: defaultMaterial({ ambient: 0.60, diffuse: [1.05, 1.02, 0.98],
                             specular: 0.60, shininess: 64,
                             texKey: 'brick', normalKey: 'brickNormal',
                             normalStrength: 1.6 }) },

    /* ⑤ 玻璃球：透明混合（E2）*/
    { id: 14, name: '玻璃球', geo: 'sphere', pickable: true,
      /* 球半径 = 0.5 × 0.85 = 0.425，所以 y = 2.19 + 0.425 = 2.615 */
      pos: [1.05, 2.615, 1.15], rot: [0, 0, 0], scale: [0.85, 0.85, 0.85],
      castShadow: true, receiveShadow: true,
      mat: defaultMaterial({ ambient: 0.30, diffuse: [0.62, 0.82, 0.90],
                             specular: 1.0, shininess: 180, reflect: 0.40,
                             alpha: 0.52 }) },

    /* ⑥ 卡通着色小球（E3）：与旁边的玻璃球并排，对比着色风格 */
    /* E3 卡通着色对比：位置往前挪一点，让方向光正面打到它，
       球面才有完整的 0~1 光照跨度，量化分档才看得出来。 */
    { id: 15, name: '卡通球', geo: 'sphere', pickable: true,
      /* 球半径 = 0.5 × 0.98 = 0.49，所以 y = 2.19 + 0.49 = 2.68 */
      pos: [-1.10, 2.680, 1.20], rot: [0, 0, 0], scale: [0.98, 0.98, 0.98],
      castShadow: true, receiveShadow: true,
      mat: defaultMaterial({ ambient: 0.70, diffuse: [1.30, 0.86, 0.30],
                             specular: 0.5, shininess: 40, toon: true }) },
  ],

  /* ------------------------------------------------------------------------
   * 光源
   * 类型 0 = 方向光（平行光，无衰减、位置无穷远）
   * 类型 1 = 点光源（有位置、有衰减）
   * 至少两盏：一盏方向光做主光（casting shadow），一盏点光做补光
   * ---------------------------------------------------------------------- */
  lights: [
    {
      type: 0,
      name: '方向光（主光）',
      /* 方向光用「指向光源的方向」表示，类似太阳斜照 */
      /* 【两个约束一起决定这三个分量】
         1) 竖直分量别太陡（-0.55 左右），影子才会被拉长到地面上；
         2) z 分量必须为「正」，即光从相机这一侧（-z 方向）照过来。
            写成负值的话，所有朝向相机的球面法线（z≈-1）都会落到背光侧，
            正面全黑——之前卡通球怎么调都发暗就是这个原因。 */
      direction: [-0.46, -0.60, 0.66],    // 光线传播方向，shader 里取反使用
      color: [1.0, 0.96, 0.88],
      intensity: 1.00,
      castShadow: true,
      /* 阴影相机（正交）覆盖范围，面板可调 */
      shadow: {
        left: -10, right: 10, bottom: -10, top: 10,
        near: 0.5, far: 45,
        mapSize: 1024,
        bias: 0.0022,
        pcf: true          // 是否启用 3×3 PCF 软阴影
      }
    },
    {
      type: 1,
      name: '点光源（补光）',
      position: [5.2, 5.4, 3.6],
      color: [0.60, 0.74, 1.0],
      intensity: 1.35,
      /* 点光源衰减：1 / (const + linear·d + quad·d²) */
      attenuation: [1.0, 0.055, 0.016],
      castShadow: false
    }
  ]
};

/* 房间尺寸常量化成几何体（在 main.js 里实例化） */
const SCENE_GEOS = {
  planeBig:    function(){ return scaleGeo(createPlane(24), ROOM.w + 4, 1, ROOM.d + 4); },
  /* 后墙要略宽于地面，否则相机斜看时墙的侧边会露出缝隙 */
  box_wallBack:function(){ return createBox(ROOM.w + 6, ROOM.h, 0.3); },
  box_wallLeft:function(){ return createBox(0.3, ROOM.h, ROOM.d); },
  box_tableTop:function(){ return createBox(6.4, 0.28, 3.4); },
  box_legA:    function(){ return createBox(0.28, 2.0, 0.28); },
  sphere:      function(){ return createSphere(48); },
  cube:        function(){ return createCube(); },
  cylinder:    function(){ return createCylinder(40); },
  torus:       function(){ return createTorus(56, 28); },
};

/* 把几何体顶点按给定比例拉伸（用于压扁的平面等） */
function scaleGeo(g, sx, sy, sz){
  const p = new Float32Array(g.pos.length);
  for(let i = 0; i < g.pos.length; i += 3){
    p[i]   = g.pos[i]   * sx;
    p[i+1] = g.pos[i+1] * sy;
    p[i+2] = g.pos[i+2] * sz;
  }
  /* 非等比缩放时法线要按逆转置变换；这里只用于地面这种水平面（法线恒 +Y），
     所以直接沿用原法线即可。 */
  return { pos: p, nrm: g.nrm, uv: g.uv, idx: g.idx };
}
