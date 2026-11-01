# WebGL 2.0 太阳系模拟 —— 实验一 / AP2

原生 WebGL 2.0 + JavaScript，零构建、零依赖（不使用 Three.js），
全部矩阵运算与着色器管理都基于教材（Angel《交互式计算机图形学》）配套的
`Common/MV.js` 与 `Common/utility.js`。

---

## 一、怎么跑起来

浏览器出于安全策略，**不允许 `file://` 协议下用 XHR/Image 读取本地纹理**，
所以必须启一个本地 HTTP 服务器（任选一种，在项目根目录执行）：

```bash
# 方式 1：Python（Windows / macOS / Linux 都自带）
python -m http.server 8000

# 方式 2：Node.js
npx serve .

# 方式 3：VS Code
# 装 "Live Server" 插件 → 右键 index.html → Open with Live Server
```

然后浏览器打开 `http://localhost:8000/index.html`。

> **Windows 路径带中文怎么办？**
> 先 `cd /d "D:\赵家佑学习\大三上\图形学\实验一\AP2"`，再执行上面的命令。
> `cd /d` 里的 `/d` 是「允许切换盘符」，不加的话从 C 盘跳不到 D 盘。

> **`index.txt` 是干什么的？**
> 它就是 `index.html` 的源码备份（纯文本，方便直接点开看/复制）。
> 运行前请把它**重命名或复制为 `index.html`**；如果目录里已经有一个
> 能正常跑的 `index.html`，直接用那个就行，两者内容一致。

---

## 二、目录结构

```
AP2/
├── index.html              ← 主程序（由 index.txt 改名而来）
├── index.txt               ← 同上，纯文本备份
├── Common/                 ← 教材配套库，未做任何修改
│   ├── MV.js               ← 矩阵/向量库（vec3/mat4/rotate/translate/mult/flatten/normalMatrix…）
│   └── utility.js          ← getShaderSource() / createProgram()
├── textures/
│   ├── sun.jpg  mercury.jpg  venus.jpg  earth.jpg  mars.jpg
│   ├── jupiter.jpg  saturn.jpg  uranus.jpg  neptune.jpg
│   ├── moon.jpg            ← 月球
│   └── saturn_ring.png     ← 土星环（含 C 环 / B 环 / 卡西尼缝 / A 环）
└── README.md
```

`MV.js` 与 `utility.js` **一字未改**，所有逻辑都写在 `index.html` 里。

---

## 三、操作说明

| 操作 | 效果 |
|---|---|
| 鼠标左键拖动 | 虚拟轨迹球旋转视角（E3） |
| 滚轮 | 缩放（改变相机距离） |
| 空格 | 暂停 / 继续动画 |
| `O` 键 | 切换 **透视投影 ↔ 正交投影** |
| 面板「透视 / 正交」按钮 | 同上 |
| 面板滑块 | 公转速度、自转速度、时间倍率、地轴倾角、月球轨道倾角 |
| 面板开关 | 轨道线、星空、小行星带、土星环、相机漫游、追踪地球 |
| 「演示日食」/「演示月食」 | 把月球吸附到日地连线上，一键看全食（E2） |
| 「复位视角」 | 四元数归零、相机距离复原 |

打开页面后，**右上角 HUD** 会显示当前投影模式、相机状态与实时帧率。

---

## 四、技术要点（对应评分项）

### 1. 三维仿射变换与齐次坐标

所有变换都用 4×4 齐次矩阵完成，统一走 `MV.js`：

```js
const m = mult(rotate(deg, vec3(0,1,0)), translate(r, 0, 0));
gl.uniformMatrix4fv(loc.uModelView, false, flatten(m));
```

**关键坑：行主序 vs 列主序。**
`MV.js` 内部用 `m[row][col]`（行主序）存储，而 GLSL 的 `mat4` 是列主序。
`MV.js` 自带的 `flatten()` 内部会做转置，所以**必须用库的 `flatten()`**；
自己手写一份「直接铺平」的 flatten 会把矩阵转置上传，
表现为物体被镜像、旋转方向反了——这是本项目踩过的第一个坑。

### 2. 三级层级建模：太阳 → 地球 → 月球

用**矩阵栈**显式管理层级：

```js
const matrixStack = [];
function pushMatrix(m){ matrixStack.push(m); }
function popMatrix(){ return matrixStack.pop(); }
function currentMV(){ return matrixStack[matrixStack.length - 1]; }
```

`push` 直接存矩阵引用（**不要**写 `mat4(m)`——
`mat4(单个矩阵参数)` 在 `MV.js` 里有个已知 bug，会把整个矩阵塞进 `out[0][0]`）。

每一帧的层级是：

```
太阳（根，世界原点）
 └─ 行星公转（轨道倾角 → 公转 → 平移半径）
     └─ 行星自转（先倾角再自转，见下）
         └─ [仅地球] 月球（轨道倾角 → 公转 → 平移 → 潮汐锁定自转）
```

### 3. 地球自转轴 23.5° 倾斜：**先施加倾角，再叠加公转**

顺序必须写成 `mult(公转, mult(倾角, 自转))`：

```js
const tiltM  = rotate(cfg.earthTilt, vec3(0, 0, 1));   // 绕 Z 轴倾斜
const spinM  = rotate(spinDeg, vec3(0, 1, 0));         // 绕自身轴自转
const local  = mult(tiltM, spinM);
```

如果反过来写成 `mult(spinM, tiltM)`，得到的是「地轴固定在空间中、
球体绕着被倾斜过的轴乱转」，**倾角不会随公转保持指向**——
北极会每帧指向不同方向，季节就没了。
正确写法下，地轴在公转过程中**始终保持同一倾斜方向**，
这才是「倾斜 23.5° 且公转」的物理含义。

**轨道倾角的旋转轴要选 Z 轴，不能选 X 轴。**
行星初始位于 `(orbit, 0, 0)`（+X 轴上），绕 X 轴旋转时
`(x, 0, 0)` 是不动点，倾角会完全失效（Y 恒为 0）。
绕 Z 轴才能把轨道面抬离黄道面。

### 4. 月球轨道面倾角：构造逻辑

月球轨道面相对黄道面倾斜 5.1°。构造器写的是：

```js
const moonOrbitTiltM = rotate(cfg.moonTilt, vec3(0, 0, 1));  // 轨道面姿态
const moonRevolveM   = rotate(moonRevDeg, vec3(0, 1, 0));    // 沿轨道公转
const moonTransM     = translate(MOON_ORBIT, 0, 0);          // 推到轨道半径
const moonSpinM      = rotate(moonRevDeg, vec3(0, 1, 0));    // 潮汐锁定自转

const moonLocal = mult(moonOrbitTiltM,
                  mult(moonRevolveM,
                  mult(moonTransM, moonSpinM)));
```

**为什么倾角必须放最外层？**
矩阵从右往左作用：②沿 +X 推出半径 → ③绕 Y 公转 → ④倾斜。
`④` 作用在「已经转好的整条轨道」上，倾斜的是**轨道面**；
若把倾角放最内层（`mult(rev, mult(trans, tilt))`），
被倾斜的将是**月球本体**——月球会歪着转，但轨道仍然是平的。

实测验证：倾角在外层时，月球 Y 坐标落在 `[-0.0933, 0.0933]`，
与 `sin(5.1°) × 1.05 = 0.0933` 完全吻合；放内层时 Y 恒为 0。

### 5. 表面纹理与 `UNPACK_FLIP_Y_WEBGL`

```js
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
gl.generateMipmap(gl.TEXTURE_2D);
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);   // 用完复位！
```

**为什么必须翻转？**
图片（JPEG/PNG）的原点在**左上角**，行的顺序是从上到下；
而 OpenGL 纹理坐标的原点在**左下角**，v 轴向上。
不做处理的话，图片的「顶部」（北极）会贴到球体的 v=0（南极），
地球看起来就是**上下颠倒**的。

`UNPACK_FLIP_Y_WEBGL` 让 GPU 在上传时按行倒序读，把两者对齐。
注意它是**全局像素存储状态**，用完必须复位成 `false`，
否则会污染后续所有 `texImage2D`（包括将来加的其它纹理）。

另外，球体 UV 的 v 写成 `1 - lat/subdiv` 与之配合：
图片顶端（v=1）对应北极，两者都不翻转或都翻转都会导致地球倒置。

**两极接缝**：`WRAP_T` 用 `CLAMP_TO_EDGE` 而不是 `REPEAT`——
球面参数化在极点处 v 恰好取到 0 和 1，用 `REPEAT` 会在极点拉出一条接缝。

### 6. 双投影对比（`O` 键切换）

```js
if(projectionMode === 'persp'){
  proj = perspective(cfg.track ? 40 : 52, aspect, 0.05, 500);
} else {
  const s = camDist * 0.52;
  proj = ortho(-s*aspect, s*aspect, -s, s, -500, 500);
}
```

**坑：`perspective` 的 fovy 单位是「角度」，不是弧度。**
`MV.js` 的 `perspective()` 内部已经调过 `radians()`，
写成 `perspective(radians(60), ...)` 会二次换算，
60° 变成 1.05°，画面直接塌缩成一个点。

透视投影下远处的行星明显变小、轨道呈椭圆；
正交投影下行星大小不随距离变化、轨道平行——两者对比能直观说明
「透视除法」的作用。

### 7. 光照

采用 Blinn-Phong，光源固定在太阳（世界原点）。
每个天体的法线矩阵由 `MV.js` 的 `normalMatrix()` 从模型视图矩阵求出：

```js
gl.uniformMatrix3fv(loc.uNormalMat, false, flatten(normalMatrix(mv)));
```

**为什么不能直接用模型视图矩阵的 3×3 部分？**
非等比缩放（行星是椭球、土星环是扁平环）会把法线「拉歪」，
必须用**逆转置**才能保持法线垂直于表面。
`normalMatrix()` 返回的是 `mat3` 对象，同样需要 `flatten()` 转置上传。

#### 7.1 光照方向必须逐天体计算（本项目最隐蔽的一个 bug）

最开始写成了「全场景共用一个常量光方向」，思路是「太阳在原点，
所以光方向就是 `normalize(−P)`」。这是**两处**错误叠加：

**错误一：方向符号取反。**
`view` 把世界变换到视图空间，太阳（世界原点）在视图空间的坐标就是
`view` 的平移列 `T = (view[0][3], view[1][3], view[2][3])`。
相机朝 −z 看时 `T.z` 是**负**的（实测 `T = (0, 0, −26)`）。
「从 P 指向太阳」= `normalize(T − P)`；当 P 是相机（视图空间原点）时
就是 `normalize(T)` 本身，**不能写成 `normalize(−T)`**。
写成 `−T` 会把整个光照翻到背面：朝阳面死黑、背阳面反而亮。

**错误二：所有天体共用一个方向。**
每颗行星的位置都不同，「从它指向太阳」的方向必然不同。
共用会让绕到太阳背后的行星永远处于背光面，配合很低的环境光就是「一片黑」。

正确做法是：把天体球心变换到视图空间，取平移列作为 `lightPos` 传给 `drawSphere`：

```js
const pivotVS = mult(currentMV(), rev.full);
const lightPos = [pivotVS[0][3], pivotVS[1][3], pivotVS[2][3]];
drawSphere(tex, planetMV, proj, { ambient:0.20, lightPos: lightPos });
```

`drawSphere` 内部再算 `L = normalize(sunPosVS − lightPos)`。

实测验证：一帧内 `uLightDir` 上传 **10 次**（太阳 + 8 行星 + 月球），
10 个方向**互不相同**，模长均为 `1.0000`，且 `dot(L, normalize(T − P)) = 1.0000`。

#### 7.2 明暗曲线要有过渡

纯兰伯特 + 低环境光会让背光面塌成纯黑，`pow(d, 0.85)` 又让明暗交界接近刀口。
现在改用：

```glsl
float diff = smoothstep(0.0, 0.92, pow(d, 0.80));
vLight = uAmbient + (1.0 - uAmbient) * diff + 0.16 * d;   // 末项是暗部「回光」
```

配合 `ambient = 0.20`，任何视角下都能连续看出球面弯曲与表面纹理。

---

## 五、扩展项

### E1：完整太阳系（8 颗行星 + 土星环 + 小行星带）

- **8 颗行星**：水、金、地、火、木、土、天、海，
  各自独立的轨道半径、公转周期、自转周期、轴向倾角、轨道倾角、初相位。
- **土星环**：独立的环形几何（内外半径 1.45 / 2.65），
  贴图为 `saturn_ring.png`，用 alpha 混合绘制：

  ```js
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false);      // 环不写深度，避免遮挡自身透明部分
  gl.disable(gl.CULL_FACE); // 环是单面几何，背面也要能看到
  ... drawElements ...
  gl.depthMask(true);
  gl.enable(gl.CULL_FACE);
  gl.disable(gl.BLEND);
  ```

  环与土星赤道面共面，因此**跟随土星 26.7° 的轴倾角**一起倾斜。

- **小行星带**：4500 个随机分布在 11.3~13.5 半径环带内的点，
  用 `gl.POINTS` 一次 `drawArrays` 画完。
  顶点着色器按 `gl_Position.w` 做距离衰减，模拟远处的颗粒感。

- **星空背景**：同样的 `POINTS` 方式，包在一个大球壳上，
  `depthMask(false)` 先画，当背景板用。

### E2：日食 / 月食模拟

**几何原理**：太阳是面光源，遮挡体背后形成两个锥。

```
本影锥（umbra）    长度 Lu = d·Rb/(Rs − Rb)
                   距离 x 处半径 Ru(x) = Rb − x·(Rs − Rb)/d
半影锥（penumbra） 距离 x 处半径 Rp(x) = Rb + x·(Rs + Rb)/d
```

其中 `d` 是**太阳到遮挡体**的距离（不是遮挡体到目标的距离——这是关键，
用错了会让本影半径恒为 0）。

判定时把「目标相对遮挡体」的向量投影到轴线上：

- `s = d⃗·û`（带符号）。`s > 0` 目标在背光侧，锥体成立；
  `s < 0` 目标在朝阳侧，**根本没有影**，直接返回 0。
- `p = |d⃗ − s·û|` 垂距。
- `p + r目标 ≤ Ru` → 全食；`p − r目标 < Rp` → 偏食。

**演示模式**（点「演示日食/月食」按钮）：
把月球公转角度直接锁成常数，让它吸附在日地连线上：

```js
moonRevDeg = (eclipseMode === 'solar') ? 180 : 0;
```

**为什么是 180 和 0，而不是 θe 和 θe+180？**
因为 `moonWorld = rev.full · moonLocal`，而 `rev.full` **已经含有地球的 R(θe)**，
月球局部角会被再叠加一次：

```
moonWorld 偏移 = R(θe) · R(moonRevDeg) · (MOON_ORBIT,0,0)
               = R(θe + moonRevDeg) · (MOON_ORBIT,0,0)
```

要让最终方向指向太阳（θe+180 方向），需要 `moonRevDeg = 180`；
指向背光侧（θe 方向），`moonRevDeg = 0`。两个值都是常数，
θe 正好被消掉——这也符合直觉：演示时月球就是被「吸附」在连线的某一端。

**演示时同时把月球轨道倾角置零**：
倾角是绕世界 Z 轴的，5.1° 会把月球抬离黄道
`1.05 × sin(5.1°) ≈ 0.093`。而演示时月球被强行摆到日地连线上，
这条线可能几乎平行于 Z 轴，此时那个抬升会被放大成很大的垂距，
月球整个滑出影锥。真实世界的「食季」正是月球轨道面与黄道面的交线
扫过日地连线的时刻，倾角的影响本来就归零，所以收掉是合理的。

**判定尺度的取舍**（写在代码注释里，也是本项最需要说明的地方）：

场景为了看得清，天体半径放大得远超真实比例——地球渲染半径 0.42，
而月地距只有 1.05（真实约 1:60）。若直接拿 0.42 当遮挡半径，
地影锥几乎覆盖整条月球轨道，月球每个周期都「全食」，
横幅一直在闪，毫无观赏性。

因此判定单独用一套「按真实比例」的小半径：

```js
const ECLIPSE_EARTH_R = 0.11;   // 判定用地影遮挡半径
const ECLIPSE_MOON_R  = 0.10;   // 判定用月影遮挡半径
const SUN_R_SOLAR = 0.095;      // 日食等效太阳半径
const SUN_R_LUNAR = 0.16;       // 月食等效太阳半径
```

调参后实测的行为：

| 场景 | 本影覆盖 | 判定 |
|---|---|---|
| 演示·日食 | 0.62 | **日全食** |
| 演示·月食 | 1.00 | **月全食** |
| 普通运行（3000 帧） | 最大 0.17 | 不误报，符合「月食稀有」的真实规律 |

### E3：虚拟轨迹球

不用 `gl-matrix` 或现成 trackball，自己实现：

1. **球面映射**：把鼠标的 `(x, y)` 映射到单位球面。
   球内用正投影 `z = √(1 − x² − y²)`；球外（超过半径 R 的区域）
   用双曲面延伸 `z = R² / (2√(d²))`，
   保证鼠标划出球外时旋转是连续的、不会突然跳变。
2. **四元数累积**：每帧算出「上一位置 → 当前位置」的旋转轴与角度，
   转成四元数后与当前姿态相乘：

   ```js
   const q = quatNormalize(quatMul(dq, trackballQuat));
   ```

   用四元数而不是欧拉角，是为了避免万向节死锁——
   欧拉角在俯仰接近 ±90° 时会出现「转不动」的病态，
   轨迹球自由拖动必然会经过这个角度，四元数则没有这个问题。
3. **自动漫游**：在四元数上累积一个绕世界 Y 轴的 `yaw`，
   再叠加一个轻微的正弦 `pitch` 摆动，空格键可暂停。

---

## 六、尺度取舍（为什么行星比真实比例大得多）

这是太阳系可视化里绕不开的一步，写在这里便于讲清楚设计意图。

**真实比例在屏幕上不可见。** 地球半径只有太阳的 1/109，
太阳在场景里取半径 2.2，地球按真实比例就该是 0.02。
在相机距离 34、垂直视野 52°、画布高 900px 的条件下，
半径 0.02 的球投影出来只有 **1 个像素左右**——画面上就是「什么都没有」。
水星、火星更小。

**因此做了两处放大，但都保留正确口径：**

1. **半径**：整体抬到 0.42~1.35，屏幕投影半径落在 **10~60 px**。
   相对大小仍按真实顺序排列：
   木星(1.35) > 土星(1.15) > 天王星(0.80) ≈ 海王星(0.78) > 地球(0.55) > 金星(0.52) > 火星(0.45) > 水星(0.42)。
2. **轨道**：保持彼此的比例关系不压缩（否则内外行星会挤在一起），
   最外圈海王星 28.6，相机距离 34 刚好留出余量。

**地月系统单独放大。** 月球轨道半径取 1.75、月球半径 0.20，
是场景单位而非真实比例（真实约 1:60）。
这样月球在全局视野下是可见的小球，切到追踪模式（`camDist = 8`）时
又能清楚看到它绕地球转、以及日月食演示时的位置关系。

| 参数 | 值 | 说明 |
|---|---|---|
| `CAM_FAR` | 34 | 全局视野相机距离 |
| `CAM_NEAR` | 8 | 追踪地球 / 日月食演示 |
| `MOON_ORBIT` | 1.75 | 月球轨道半径 |
| `MOON_R` | 0.20 | 月球半径 |
| `RING_INNER` / `RING_OUTER` | 1.45 / 2.65 | 土星环内外径 |

改这两个相机常量就能整体调整取景，代码里其余位置一律引用常量，不要再写死数字。

---

## 七、性能与工程细节

- **Uniform 位置缓存**：`getUniformLocation` 在初始化时一次取完，
  存进 `loc` 对象，避免每帧对每个对象重复查询（这是 WebGL 常见的性能杀手）。
- **VAO**：`gl.createVertexArray` 一次性建好几何体的 VAO，
  每帧只 `bindVertexArray`，不再重复 `bufferData`。
  注意 `ELEMENT_ARRAY_BUFFER` 的绑定是 **VAO 状态**的一部分，
  而 `ARRAY_BUFFER` 不是——混用会导致索引错乱。
- **轨道线**：所有轨道圆在初始化时用 `buildCircleVAO()` 一次建好，
  不在每帧重新上传顶点（早期版本因为每帧 `bufferData` 覆盖了别的 VBO，
  导致行星位置全乱）。
- **贴图缓存**：`texCache` 按文件名缓存，同一张图只上传一次；
  加载完成前先用 1×1 白色占位纹理，避免首帧黑屏。
- **纹理缺失兜底**：任何 `loadTex` 失败都保留占位纹理，
  不会抛错中断渲染（所以即使少几张图，程序也能正常跑，只是球是纯色的）。

---

## 八、验证记录

以下项目均用 Node + `vm` 加载真实的 `MV.js` / `utility.js`，
以 mock WebGL 驱动真实的 `render()` 逐帧探针验证（非目测）：

| 检查项 | 结果 |
|---|---|
| 每帧 `drawElements` 次数 | 11（太阳 + 8 行星 + 土星环 + 月球）✓ |
| 每帧 `uLightDir` 上传次数 | 10（太阳 + 8 行星 + 月球）✓ |
| 10 个光照方向是否互不相同 | 去重后仍为 10，模长全部 1.0000 ✓ |
| `L = normalize(太阳位置 − 天体位置)` | 9/9 天体 `dot = 1.0000` ✓ |
| 行星视图空间位置 | z ∈ [−13, −46]，均在视锥前方 ✓ |
| 行星屏幕投影半径（画布高 900px） | 10.4 ~ 59.6 px，全部落在视口内未越界 ✓ |
| 投影矩阵切换 | 透视 `m[11] = −1`，正交 `m[11] = 0` ✓ |
| 所有上传矩阵是否有限值 | 无 NaN / Infinity ✓ |
| 月球到地球距离 | 恒为 1.750000 ✓ |
| 月球轨道倾角（外层） | Y 最大 0.1541 ≈ sin(5.1°)×1.75 = 0.1556 ✓ |
| 月球轨道倾角（内层，对照） | Y 恒为 0（证明顺序必须在外层）✓ |
| 行星轨道倾角生效 | `|Y|/r` 与 `sin(incl)·|cos(rev)|` 吻合 ✗→✓（已修） |
| 法线矩阵正确性 | 非等比缩放下法线仍垂直，误差 1e-8 量级 ✓ |
| 日月食演示定位 | 月球偏移与「地球→太阳」单位向量 cos = 1.0000 ✓ |
| 日月食判定 | 日食 → 「日全食」，月食 → 「月全食」✓ |
| 普通模式 400 帧 | 无误报 ✓ |
| 轨迹球拖拽 | 四元数模长 1.000000，视角正确旋转 ✓ |
| 滚轮缩放 | `camDist` 34 → 37.88（e^0.108）✓ |
| 面板全部开关 | 均可正常切换且不报错 ✓ |
| 贴图加载失败提示 | 失败时顶部横幅 + 左下角角标变橙，均可见 ✓ |

---

## 九、贴图来源

行星表面贴图来自 [Solar System Scope](https://www.solarsystemscope.com/textures/)
（CC BY 4.0），分辨率 2K。月球贴图同源。
`saturn_ring.png` 与 `uranus.jpg`、`neptune.jpg` 为程序生成
（含 C 环 / B 环 / 卡西尼缝 / A 环分区，以及海王星大暗斑），
以避免版权问题并保持风格统一。
