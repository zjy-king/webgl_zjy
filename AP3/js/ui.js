/* ==========================================================================
 * ui.js  ——  参数面板（HTML 生成 + 事件绑定）
 * --------------------------------------------------------------------------
 * 面板分三块：
 *   A. 光照三分量开关 + 全局参数（评分项：三分量独立开关）
 *   B. 全局：方向光/点光参数、阴影相机参数
 *   C. 选中物体的材质参数（拾取后自动切换，评分项：选中即调参）
 *
 * 所有控件用代码生成而不是写死在 HTML 里，因为 C 块要随选中物体动态重建。
 * ========================================================================== */
'use strict';

const UI = (function(){

  let root = null;
  let state = null;        // 指向 main.js 的全局状态
  let onMeshParamsChange = null;

  /* 滑块定义表：[id, 标签, min, max, step, 取值函数, 写值函数, 单位] */
  function buildSlider(cfg){
    const wrap = document.createElement('div');
    wrap.className = 'row';

    const head = document.createElement('div');
    head.className = 'row-head';

    const label = document.createElement('label');
    label.textContent = cfg.label;

    const val = document.createElement('span');
    val.className = 'val';

    head.appendChild(label);
    head.appendChild(val);
    wrap.appendChild(head);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = cfg.min;
    input.max = cfg.max;
    input.step = cfg.step;
    input.value = cfg.get();

    const fmt = cfg.fmt || function(v){ return Number(v).toFixed(2) + (cfg.unit || ''); };
    val.textContent = fmt(input.value);

    input.oninput = function(){
      const v = parseFloat(input.value);
      cfg.set(v);
      val.textContent = fmt(v);
      if(cfg.onInput) cfg.onInput(v);
    };

    wrap.appendChild(input);
    wrap._refresh = function(){
      const v = cfg.get();
      input.value = v;
      val.textContent = fmt(v);
    };
    return wrap;
  }

  function buildCheckbox(label, get, set){
    const wrap = document.createElement('label');
    wrap.className = 'chk';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = get();
    input.onchange = function(){ set(input.checked); };
    const span = document.createElement('span');
    span.textContent = label;
    wrap.appendChild(input);
    wrap.appendChild(span);
    wrap._refresh = function(){ input.checked = get(); };
    return wrap;
  }

  function buildSection(title){
    const sec = document.createElement('section');
    const h = document.createElement('h3');
    h.textContent = title;
    sec.appendChild(h);
    sec._refreshers = [];
    return sec;
  }

  function addRow(sec, el){
    sec.appendChild(el);
    if(el._refresh) sec._refreshers.push(el._refresh);
  }

  /* ======================================================================
   * 初始化
   * ====================================================================== */
  function init(stateRef, meshChangeCb){
    state = stateRef;
    onMeshParamsChange = meshChangeCb;
    root = document.getElementById('panelBody');
    rebuild();
  }

  /* ======================================================================
   * 重建整个面板（选中物体变化时只重建 C 块）
   * ====================================================================== */
  function rebuild(){
    root.innerHTML = '';

    /* ---------------- A. 光照三分量 ---------------- */
    const secLight = buildSection('Phong 三分量');

    addRow(secLight, buildCheckbox('环境光 Ambient',
      function(){ return state.useAmbient; },
      function(v){ state.useAmbient = v; }));
    addRow(secLight, buildCheckbox('漫反射 Diffuse',
      function(){ return state.useDiffuse; },
      function(v){ state.useDiffuse = v; }));
    addRow(secLight, buildCheckbox('镜面 Specular',
      function(){ return state.useSpecular; },
      function(v){ state.useSpecular = v; }));

    /* 一键切换四种组合，方便截图 */
    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';
    [['仅环境', [1,0,0]], ['仅漫反射', [0,1,0]], ['仅镜面', [0,0,1]], ['全开', [1,1,1]]]
      .forEach(function(item){
        const b = document.createElement('button');
        b.textContent = item[0];
        b.onclick = function(){
          state.useAmbient  = !!item[1][0];
          state.useDiffuse  = !!item[1][1];
          state.useSpecular = !!item[1][2];
          refreshAll();
          if(window.onPresetChanged) window.onPresetChanged();
        };
        btnRow.appendChild(b);
      });
    secLight.appendChild(btnRow);

    addRow(secLight, buildSlider({
      label: '全局环境光强度',
      min: 0, max: 1, step: 0.01,
      get: function(){ return state.globalAmbient; },
      set: function(v){ state.globalAmbient = v; }
    }));

    root.appendChild(secLight);

    /* ---------------- B. 光源 ---------------- */
    const secLamp = buildSection('光源');

    addRow(secLamp, buildSlider({
      label: '方向光强度',
      min: 0, max: 2, step: 0.01,
      get: function(){ return state.lights[0].intensity; },
      set: function(v){ state.lights[0].intensity = v; }
    }));

    addRow(secLamp, buildSlider({
      label: '点光强度',
      min: 0, max: 2, step: 0.01,
      get: function(){ return state.lights[1].intensity; },
      set: function(v){ state.lights[1].intensity = v; }
    }));

    addRow(secLamp, buildSlider({
      label: '点光高度',
      min: 1.5, max: 8.5, step: 0.05,
      get: function(){ return state.lights[1].position[1]; },
      set: function(v){ state.lights[1].position[1] = v; },
      fmt: function(v){ return Number(v).toFixed(2); }
    }));

    root.appendChild(secLamp);

    /* ---------------- C. 阴影 ---------------- */
    const secShadow = buildSection('阴影贴图');

    addRow(secShadow, buildCheckbox('启用阴影',
      function(){ return state.shadowEnabled; },
      function(v){ state.shadowEnabled = v; }));

    const sizes = [256, 512, 1024, 2048];
    const sizeWrap = document.createElement('div');
    sizeWrap.className = 'row';
    sizeWrap.innerHTML = '<div class="row-head"><label>阴影贴图分辨率</label></div>';
    const sizeRow = document.createElement('div');
    sizeRow.className = 'btn-row';
    sizes.forEach(function(s){
      const b = document.createElement('button');
      b.textContent = s + '²';
      b.onclick = function(){
        state.shadowMapSize = s;
        if(window.onShadowMapSizeChange) window.onShadowMapSizeChange(s);
        Array.prototype.forEach.call(sizeRow.children, function(c){
          c.classList.toggle('on', c === b);
        });
      };
      b.classList.toggle('on', s === state.shadowMapSize);
      sizeRow.appendChild(b);
    });
    sizeWrap.appendChild(sizeRow);
    secShadow.appendChild(sizeWrap);

    addRow(secShadow, buildSlider({
      label: '深度偏移 bias',
      min: 0, max: 0.02, step: 0.0002,
      get: function(){ return state.lights[0].shadow.bias; },
      set: function(v){ state.lights[0].shadow.bias = v; },
      fmt: function(v){ return Number(v).toFixed(4); }
    }));

    addRow(secShadow, buildSlider({
      label: '光源范围（越小越清晰）',
      min: 4, max: 16, step: 0.1,
      get: function(){ return state.lights[0].shadow.right; },
      set: function(v){
        const s = state.lights[0].shadow;
        s.left = -v; s.right = v; s.bottom = -v; s.top = v;
      },
      fmt: function(v){ return '±' + Number(v).toFixed(1); }
    }));

    addRow(secShadow, buildCheckbox('PCF 软阴影（3×3）',
      function(){ return state.lights[0].shadow.pcf; },
      function(v){ state.lights[0].shadow.pcf = v; }));

    root.appendChild(secShadow);

    /* ---------------- D. 选中物体材质 ---------------- */
    const secMat = buildSection('选中物体材质');
    const info = document.createElement('div');
    info.className = 'sel-info';
    info.id = 'selInfo';
    secMat.appendChild(info);

    const matBody = document.createElement('div');
    matBody.id = 'matBody';
    secMat.appendChild(matBody);

    root.appendChild(secMat);

    refreshAll();
    rebuildMeshParams();
  }

  /* ======================================================================
   * D 块：随选中物体动态重建
   * ====================================================================== */
  function rebuildMeshParams(){
    const info = document.getElementById('selInfo');
    const body = document.getElementById('matBody');
    if(!body) return;

    const obj = state.selectedId ? state.objects.find(function(o){ return o.id === state.selectedId; }) : null;

    if(!obj){
      info.innerHTML = '<span class="hint">点击场景中的物体来选中它</span>';
      body.innerHTML = '';
      return;
    }

    info.innerHTML = '<b>' + obj.name + '</b><span class="hint">　id=' + obj.id + '</span>';

    body.innerHTML = '';
    const m = obj.mat;

    /* 高光指数（对数刻度：1~256 用滑块线性会很不好拖） */
    body.appendChild(buildSlider({
      label: '高光指数 n',
      min: 1, max: 256, step: 1,
      get: function(){ return m.shininess; },
      set: function(v){ m.shininess = v; },
      fmt: function(v){ return String(Math.round(v)); }
    }));

    /* 镜面强度 */
    body.appendChild(buildSlider({
      label: '镜面强度 ks',
      min: 0, max: 1.5, step: 0.01,
      get: function(){ return m.specular; },
      set: function(v){ m.specular = v; }
    }));

    /* 环境光系数 */
    body.appendChild(buildSlider({
      label: '环境光系数 ka',
      min: 0, max: 1.5, step: 0.01,
      get: function(){ return m.ambient; },
      set: function(v){ m.ambient = v; }
    }));

    /* 漫反射颜色 */
    const colorRow = document.createElement('div');
    colorRow.className = 'row';
    colorRow.innerHTML = '<div class="row-head"><label>漫反射颜色 kd</label></div>';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = rgbToHex(m.diffuse);
    colorInput.oninput = function(){
      m.diffuse = hexToRgb(colorInput.value);
    };
    colorRow.appendChild(colorInput);
    body.appendChild(colorRow);

    /* 反射比例（只对支持环境贴图的物体有意义） */
    if(m.reflect > 0 || m.texKey === null){
      body.appendChild(buildSlider({
        label: '环境反射比例',
        min: 0, max: 1, step: 0.01,
        get: function(){ return m.reflect; },
        set: function(v){ m.reflect = v; }
      }));
    }

    /* 法线贴图强度（仅 E1 那个环） */
    if(m.normalKey){
      body.appendChild(buildSlider({
        label: '法线贴图强度',
        min: 0, max: 3, step: 0.05,
        get: function(){ return m.normalStrength; },
        set: function(v){ m.normalStrength = v; }
      }));
    }

    /* UV 平铺倍数（有贴图的物体才有意义） */
    if(m.texKey){
      body.appendChild(buildSlider({
        label: 'UV 平铺 U',
        min: 1, max: 8, step: 0.5,
        get: function(){ return m.uvScale[0]; },
        set: function(v){ m.uvScale[0] = v; }
      }));
      body.appendChild(buildSlider({
        label: 'UV 平铺 V',
        min: 1, max: 8, step: 0.5,
        get: function(){ return m.uvScale[1]; },
        set: function(v){ m.uvScale[1] = v; }
      }));
    }

    /* 透明度（仅 E2 玻璃球） */
    if(m.alpha < 1){
      body.appendChild(buildSlider({
        label: '不透明度',
        min: 0.1, max: 1, step: 0.01,
        get: function(){ return m.alpha; },
        set: function(v){ m.alpha = v; }
      }));
    }

    /* 卡通着色开关（E3） */
    if(obj.id === 15){
      body.appendChild(buildCheckbox('卡通着色（toon）',
        function(){ return m.toon; },
        function(v){ m.toon = v; }));
    }
  }

  /* 刷新 A/B 块的控件显示（不动 D 块） */
  function refreshAll(){
    const all = root.querySelectorAll('section');
    Array.prototype.forEach.call(all, function(sec){
      if(sec._refreshers) sec._refreshers.forEach(function(f){ f(); });
    });
    /* 按钮的 on 状态 */
    const btnRow = root.querySelector('.btn-row');
  }

  function rgbToHex(c){
    const f = function(v){
      const s = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16);
      return s.length === 1 ? '0' + s : s;
    };
    return '#' + f(c[0]) + f(c[1]) + f(c[2]);
  }

  function hexToRgb(h){
    return [
      parseInt(h.substr(1, 2), 16) / 255,
      parseInt(h.substr(3, 2), 16) / 255,
      parseInt(h.substr(5, 2), 16) / 255
    ];
  }

  return {
    init: init,
    rebuild: rebuild,
    rebuildMeshParams: rebuildMeshParams,
    refreshAll: refreshAll
  };
})();
