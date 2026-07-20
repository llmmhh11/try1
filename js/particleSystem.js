/**
 * ParticleSystem.js
 * 粒子音乐播放器 — 核心粒子系统
 * 
 * 功能：
 * 1. 彩色粒子随机分布在3D空间
 * 2. 播放时粒子汇聚成专辑封面方形
 * 3. 波浪式浮动（自左上至右下，Y轴+Z轴立体延伸）
 * 4. 音频频谱实时驱动粒子脉动
 */

import * as THREE from 'three';

export class ParticleSystem {
    constructor(canvas) {
        this.canvas = canvas;
        this.particleCount = 87500;
        this.coverSize = 14;         // 封面方形边长（世界坐标），刚好填充顶部栏与底部进度条之间
        this.coverCols = 250;        // 封面列数（水平粒子数），列间距稍大
        this.coverRows = 350;        // 封面行数（垂直粒子数），保持密度
        this.density = 0.2;           // 粒子密度（锁定最低，粒子细腻精致）
        this.waveIntensity = 1.5;     // 波浪强度（默认拉满）
        this.audioLevel = 0;          // 当前音频电平
        this.transition = 0;          // 过渡进度 0=随机 1=封面
        this.targetTransition = 0;    // 目标过渡值
        this.isPlaying = false;
        this.coverColors = null;      // 专辑封面颜色数据
        this.mouseX = 0;
        this.mouseY = 0;
        this.targetRotationX = 0;
        this.targetRotationY = 0;
        this.currentRotationX = 0;
        this.currentRotationY = 0;

        // 轨道拖拽状态
        this.isDragging = false;
        this.prevMouseX = 0;
        this.prevMouseY = 0;
        this.orbitTheta = 0;          // 水平旋转角（弧度）
        this.orbitPhi = 0;            // 垂直旋转角
        this.targetOrbitTheta = 0;
        this.targetOrbitPhi = 0;
        this.velocityX = 0;           // 惯性速度
        this.velocityY = 0;
        this.targetZoom = 14;         // 相机距离
        this.currentZoom = 14;
        this.minZoom = 6;
        this.maxZoom = 30;
        this.dragSensitivity = 0.005; // 拖拽灵敏度

        // 方形点击检测（区分点击 vs 拖拽）
        this._squareClicked = false;   // 本次 mouseup 是否击中方形
        this.onSquareClick = null;      // 方形点击回调（外部设置）
        this._mouseDownPos = null;      // mousedown 屏幕坐标（null = 未在 canvas 上按下）
        this._mouseDownTime = 0;
        this._touchStartPos = null;     // touchstart 屏幕坐标
        this._touchStartTime = 0;

        this._init();
        this._bindEvents();
        this._animate();
    }

    /**
     * 初始化 Three.js 场景
     */
    _init() {
        // 场景
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0x000000, 0.015);

        // 相机
        this.camera = new THREE.PerspectiveCamera(
            60,
            window.innerWidth / window.innerHeight,
            0.1,
            100
        );
        this.camera.position.set(0, 0, 14);

        // 渲染器
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            alpha: true,
            powerPreference: 'high-performance'
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setClearColor(0x000000, 0);

        // 创建粒子
        this._createParticles();

        // 环境光（虽然粒子用ShaderMaterial不需要光照，但留作扩展）
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    }

    /**
     * 创建粒子系统
     */
    _createParticles() {
        const count = this.particleCount;

        // 几何体属性
        const positions = new Float32Array(count * 3);      // 当前位置（用于渲染管线占位）
        const randomPositions = new Float32Array(count * 3); // 随机初始位置
        const targetPositions = new Float32Array(count * 3); // 目标位置（封面像素）
        const colors = new Float32Array(count * 3);          // 粒子颜色
        const sizes = new Float32Array(count);               // 粒子大小
        const randomSeeds = new Float32Array(count);         // 随机种子（用于个体差异）

        const half = this.coverSize / 2;

        for (let i = 0; i < count; i++) {
            const i3 = i * 3;

            // 随机初始位置 — 球形分布
            const radius = 6 + Math.random() * 8;
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            randomPositions[i3]     = radius * Math.sin(phi) * Math.cos(theta);
            randomPositions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
            randomPositions[i3 + 2] = radius * Math.cos(phi);

            // 目标位置 — 默认在方形区域内均匀分布
            // 实际播放时会根据专辑封面像素重新计算
            const tx = (Math.random() - 0.5) * this.coverSize;
            const ty = (Math.random() - 0.5) * this.coverSize;
            const tz = 0.0;
            targetPositions[i3]     = tx;
            targetPositions[i3 + 1] = ty;
            targetPositions[i3 + 2] = tz;

            // 初始位置设为随机位置
            positions[i3]     = randomPositions[i3];
            positions[i3 + 1] = randomPositions[i3 + 1];
            positions[i3 + 2] = randomPositions[i3 + 2];

            // 黑白色系
            const palette = [
                [1.0, 1.0, 1.0],     // 纯白
                [0.75, 0.75, 0.75],  // 浅灰
                [0.5, 0.5, 0.5],     // 中灰
                [0.3, 0.3, 0.3],     // 深灰
                [0.15, 0.15, 0.15],  // 暗灰
            ];
            const color = palette[Math.floor(Math.random() * palette.length)];
            colors[i3]     = color[0];
            colors[i3 + 1] = color[1];
            colors[i3 + 2] = color[2];

            // 粒子大小 — 柔和范围，圆粒子美学
            sizes[i] = 0.8 + Math.random() * 0.8;

            // 随机种子
            randomSeeds[i] = Math.random();
        }

        // 几何体
        this.geometry = new THREE.BufferGeometry();
        this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        this.geometry.setAttribute('aRandomPos', new THREE.BufferAttribute(randomPositions, 3));
        this.geometry.setAttribute('aTargetPos', new THREE.BufferAttribute(targetPositions, 3));
        this.geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
        this.geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
        this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(randomSeeds, 1));

        // 着色器材质
        // 使用 NormalBlending — 粒子颜色即封面像素本色，不会因叠加而泛白
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                uTime: { value: 0 },
                uTransition: { value: 0 },
                uWaveIntensity: { value: this.waveIntensity },
                uAudioLevel: { value: 0 },
                uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
                uCoverSize: { value: this.coverSize },
                uPointScale: { value: 28.0 },  // 粒子直径2.4px > 单元格√2倍(2.21px)，对角线无间隙
                uDensity: { value: 0.7 },       // 密度归一化，补偿亮度
                uWaveAlign: { value: 1.0 }      // 视角对齐度：正面=0波浪关闭，旋转后=1开启
            },
            vertexShader: this._getVertexShader(),
            fragmentShader: this._getFragmentShader(),
            transparent: true,
            depthWrite: false,
            blending: THREE.NormalBlending
        });

        this.points = new THREE.Points(this.geometry, this.material);
        this.points.frustumCulled = false; // 粒子位置在着色器中动态计算，禁用剔除
        this.scene.add(this.points);

        // 粒子方形居中偏左（为右侧歌词腾空间）
        this.points.position.x = -2.5;
    }

    /**
     * 顶点着色器
     * 核心逻辑：
     * 1. 随机位置 ↔ 封面目标位置 的平滑过渡
     * 2. 波浪从左上角到右下角传播（沿对角线方向）
     * 3. Y轴方向浮动（上下）+ Z轴方向浮动（向用户，立体感）
     * 4. 音频电平驱动粒子脉动
     */
    _getVertexShader() {
        return `
            attribute vec3 aRandomPos;
            attribute vec3 aTargetPos;
            attribute vec3 aColor;
            attribute float aSize;
            attribute float aSeed;

            uniform float uTime;
            uniform float uTransition;
            uniform float uWaveIntensity;
            uniform float uAudioLevel;
            uniform float uPixelRatio;
            uniform float uCoverSize;
            uniform float uPointScale;
            uniform float uDensity;
            uniform float uWaveAlign;

            varying vec3 vColor;
            varying float vAlpha;
            varying float vGlow;

            // 简易噪声函数
            float hash(float n) {
                return fract(sin(n) * 43758.5453123);
            }

            void main() {
                // ========== 位置过渡 ==========
                // 使用平滑曲线让过渡更自然
                float t = smoothstep(0.0, 1.0, uTransition);
                
                // 个体延迟 — 每个粒子有轻微不同的过渡时机
                float delay = aSeed * 0.3;
                float delayedT = smoothstep(delay, delay + 0.7, uTransition);
                
                vec3 pos = mix(aRandomPos, aTargetPos, delayedT);

                // ========== 多条不规则波浪 ==========
                // 归一化坐标 (-1 to 1)，作为波浪计算基础
                float halfCover = uCoverSize * 0.5;
                float nx = aTargetPos.x / halfCover;
                float ny = aTargetPos.y / halfCover;
                float dist = length(vec2(nx, ny));

                // 6条不同方向/速度/频率的波浪，每条粒子有独立相位偏移
                // 每条波的相位 = 空间位置项 + 时间项 + 随机种子项（不规律的关键）

                // 波1：对角线（左上→右下），慢速大振幅
                float w1 = sin((nx - ny) * 3.7 - uTime * 0.60 + aSeed * 2.5) * 1.0;

                // 波2：反对角线（右上→左下），中速
                float w2 = sin((nx + ny) * 5.3 - uTime * 0.82 + aSeed * 4.1) * 0.8;

                // 波3：水平方向（左→右），较快
                float w3 = cos(nx * 7.1 - uTime * 1.05 + aSeed * 3.3) * 0.65;

                // 波4：垂直方向（上→下）
                float w4 = cos(ny * 6.5 - uTime * 0.75 + aSeed * 5.7) * 0.55;

                // 波5：径向（从中心向外扩散）
                float w5 = sin(dist * 8.3 - uTime * 1.30 + aSeed * 2.8) * 0.50;

                // 波6：不规则交叉波（X*Y 乘积产生棋盘格状传播，天然不规律）
                float w6 = sin(nx * 4.2 + ny * 3.1 - uTime * 0.48 + aSeed * 7.3)
                         * cos(nx * 5.8 - ny * 4.4 + uTime * 0.55 + aSeed * 1.9) * 0.35;

                // 加权叠加（总和除以权重和，保证振幅可控）
                // uWaveAlign=0 → 正面视图波浪静止；uWaveAlign=1 → 侧面视图波浪全开
                float wave = (w1 + w2 + w3 + w4 + w5 + w6) / 3.85 * uWaveIntensity * uWaveAlign;

                // Y轴浮动（上下）
                float yWave = wave * 0.8 * delayedT;
                pos.y += yWave;

                // Z轴浮动（立体纵深）
                float zWave = wave * 1.2 * delayedT;
                pos.z += zWave;

                // ========== 音频响应 ==========
                // 音频驱动粒子向外脉动
                float audioPulse = uAudioLevel * (0.5 + aSeed * 0.5);
                
                // 封面状态下：粒子在Z轴方向脉动
                pos.z += audioPulse * 1.5 * delayedT;
                
                // 随机状态下：粒子向外扩散
                vec3 outwardDir = normalize(aRandomPos + vec3(0.001));
                pos += outwardDir * audioPulse * 2.0 * (1.0 - delayedT);

                // ========== 微小浮动（增加生气，仅随机态）==========
                // 封面状态下抑制浮动，保持像素精准对齐
                float microFloat = sin(uTime * 0.5 + aSeed * 10.0) * 0.05 * (1.0 - delayedT);
                pos.x += microFloat;
                pos.y += microFloat;

                // ========== 渲染 ==========
                vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
                gl_Position = projectionMatrix * mvPosition;

                // 粒子大小 — 距离衰减 + 音频增强
                // uPointScale 控制粒子在屏幕上的像素大小，调整它让封面粒子紧密排列
                float baseSize = aSize * (uPointScale / max(-mvPosition.z, 0.1));
                baseSize *= (1.0 + audioPulse * 0.6);
                gl_PointSize = baseSize * uPixelRatio;

                // 颜色 — 保持本色
                vColor = aColor;
                // alpha：封面态完全显示(1.0)，密度补偿防止大小粒子亮度不均
                // uDensity↑→粒子大→补偿乘数↓，uDensity↓→粒子小→补偿乘数↑
                float densityComp = 1.0 / (0.4 + uDensity * 0.6);
                vAlpha = (0.3 + delayedT * 0.7) * densityComp;
                vAlpha = clamp(vAlpha, 0.0, 1.0);
                // 发光强度 — 仅在音频脉冲时增强
                vGlow = audioPulse * 2.0;
            }
        `;
    }

    /**
     * 片元着色器
     * 3D 球型粒子 — 模拟球形光照（漫反射 + 高光 + 边缘暗化）
     */
    _getFragmentShader() {
        return `
            varying vec3 vColor;
            varying float vAlpha;
            varying float vGlow;

            void main() {
                // 圆形裁剪
                vec2 center = gl_PointCoord - vec2(0.5);
                float dist = length(center);
                
                if (dist > 0.5) discard;

                // ── 3D 球型法线 ──
                float z = sqrt(max(0.0, 0.25 - dist * dist));
                vec3 normal = normalize(vec3(center.x, center.y, z));

                // ── 漫反射（光源从左上）──
                vec3 lightDir = normalize(vec3(0.35, -0.45, 1.0));
                float diffuse = max(dot(normal, lightDir), 0.0);
                // 微环境光，避免暗面全黑
                float ambient = 0.25;

                // ── 高光（Blinn-Phong 半角向量）──
                vec3 viewDir = vec3(0.0, 0.0, 1.0);
                vec3 halfDir = normalize(lightDir + viewDir);
                float specular = pow(max(dot(normal, halfDir), 0.0), 32.0);
                specular *= 0.4;

                // ── 边缘暗化（菲涅尔效应）──
                float fresnel = smoothstep(0.3, 0.5, dist);

                // ── 合成颜色 ──
                float light = ambient + diffuse * 0.75 + specular;
                vec3 color = vColor * light;
                // 边缘暗化
                color = mix(color, color * 0.35, fresnel);
                // 高光叠加（白色调）
                color += vColor * specular * 0.5;

                // 音频发光
                color += vColor * vGlow * 0.2;

                // ── alpha — 锐利边缘保证无间隙 ──
                float alpha = smoothstep(0.5, 0.42, dist) * vAlpha;

                gl_FragColor = vec4(color, alpha);
            }
        `;
    }

    /**
     * 设置专辑封面 — 从图片提取像素颜色，映射为粒子目标位置
     */
    setCoverImage(image) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const cols = this.coverCols;
        const rows = this.coverRows;
        canvas.width = cols;
        canvas.height = rows;

        // 绘制图片到 canvas（裁剪为正方形）
        const minDim = Math.min(image.width, image.height);
        const sx = (image.width - minDim) / 2;
        const sy = (image.height - minDim) / 2;
        ctx.drawImage(image, sx, sy, minDim, minDim, 0, 0, cols, rows);

        const imageData = ctx.getImageData(0, 0, cols, rows);
        const pixels = imageData.data;

        // 更新粒子目标位置和颜色
        const targetPositions = this.geometry.attributes.aTargetPos.array;
        const colors = this.geometry.attributes.aColor.array;
        const half = this.coverSize / 2;
        const totalPixels = cols * rows;

        // 步进比例：粒子数 vs 像素总数，1:1精准映射
        const stepRatio = totalPixels / this.particleCount;

        for (let i = 0; i < this.particleCount; i++) {
            const i3 = i * 3;

            // 步进采样 — 每个粒子精准对应一个封面像素
            const pixelIndex = Math.floor(i * stepRatio);
            const px = pixelIndex % cols;
            const py = Math.floor(pixelIndex / cols);
            const idx = (py * cols + px) * 4;

            // 像素级精准定位：水平用cols、垂直用rows
            const tx = ((px + 0.5) / cols) * this.coverSize - half;
            const ty = -((py + 0.5) / rows) * this.coverSize + half;
            const tz = 0.0;

            targetPositions[i3]     = tx;
            targetPositions[i3 + 1] = ty;
            targetPositions[i3 + 2] = tz;

            // 颜色 — 从封面像素直接采样
            colors[i3]     = pixels[idx] / 255;
            colors[i3 + 1] = pixels[idx + 1] / 255;
            colors[i3 + 2] = pixels[idx + 2] / 255;
        }

        this.geometry.attributes.aTargetPos.needsUpdate = true;
        this.geometry.attributes.aColor.needsUpdate = true;

        this.coverColors = pixels;
    }

    /**
     * 重置为默认彩色粒子（无封面时）
     */
    resetDefaultColors() {
        const colors = this.geometry.attributes.aColor.array;
        const targetPositions = this.geometry.attributes.aTargetPos.array;
        const half = this.coverSize / 2;

        const palette = [
            [1.0, 1.0, 1.0],
            [0.75, 0.75, 0.75],
            [0.5, 0.5, 0.5],
            [0.3, 0.3, 0.3],
            [0.15, 0.15, 0.15],
        ];

        for (let i = 0; i < this.particleCount; i++) {
            const i3 = i * 3;
            const color = palette[Math.floor(Math.random() * palette.length)];
            colors[i3]     = color[0];
            colors[i3 + 1] = color[1];
            colors[i3 + 2] = color[2];

            // 目标位置重置为方形区域内随机分布
            targetPositions[i3]     = (Math.random() - 0.5) * this.coverSize;
            targetPositions[i3 + 1] = (Math.random() - 0.5) * this.coverSize;
            targetPositions[i3 + 2] = 0.0;
        }

        this.geometry.attributes.aColor.needsUpdate = true;
        this.geometry.attributes.aTargetPos.needsUpdate = true;
    }

    /**
     * 播放状态 — 粒子汇聚成封面
     */
    play() {
        this.isPlaying = true;
        this.targetTransition = 1;
    }

    /**
     * 暂停状态 — 粒子保持封面但减弱波浪
     */
    pause() {
        this.isPlaying = false;
        // 暂停时不完全散开，保持封面形态但波浪减弱
    }

    /**
     * 停止 — 粒子散开回随机分布
     */
    stop() {
        this.isPlaying = false;
        this.targetTransition = 0;
    }

    /**
     * 设置波浪强度
     */
    setWaveIntensity(value) {
        this.waveIntensity = value;
    }

    /**
     * 设置粒子密度
     */
    setDensity(value) {
        this.density = value;
        this.material.uniforms.uDensity.value = value;
        // 密度影响粒子大小，范围收窄减少亮度波动
        const sizes = this.geometry.attributes.aSize.array;
        for (let i = 0; i < this.particleCount; i++) {
            sizes[i] = (0.8 + Math.random() * 0.8) * (0.5 + value * 0.5);
        }
        this.geometry.attributes.aSize.needsUpdate = true;
    }

    /**
     * 更新音频数据
     * @param {Number} level - 音频电平 (0-1)
     */
    updateAudio(level) {
        this.audioLevel = level;
    }

    /**
     * 事件绑定 — 鼠标拖拽轨道旋转 + 滚轮缩放
     */
    _bindEvents() {
        window.addEventListener('resize', () => this._onResize());

        const canvas = this.canvas;

        // ── 鼠标拖拽旋转 ──
        canvas.addEventListener('mousedown', (e) => {
            this._mouseDownPos = { x: e.clientX, y: e.clientY };
            this._mouseDownTime = Date.now();
            this.isDragging = true;
            this.prevMouseX = e.clientX;
            this.prevMouseY = e.clientY;
            // 停止惯性
            this.velocityX = 0;
            this.velocityY = 0;
            this.targetOrbitTheta = this.orbitTheta;
            this.targetOrbitPhi = this.orbitPhi;
        });

        window.addEventListener('mousemove', (e) => {
            if (this.isDragging) {
                const dx = e.clientX - this.prevMouseX;
                const dy = e.clientY - this.prevMouseY;

                this.targetOrbitTheta += dx * this.dragSensitivity;
                this.targetOrbitPhi   += dy * this.dragSensitivity;
                // 限制垂直角度，避免翻到底部
                this.targetOrbitPhi = Math.max(-1.4, Math.min(1.4, this.targetOrbitPhi));

                this.prevMouseX = e.clientX;
                this.prevMouseY = e.clientY;
            }
        });

        window.addEventListener('mouseup', (e) => {
            if (this.isDragging) {
                // 惯性速度：取当前 orbit 与 target 的差值作为衰减速度
                this.velocityX = (this.targetOrbitTheta - this.orbitTheta) * 0.5;
                this.velocityY = (this.targetOrbitPhi - this.orbitPhi) * 0.5;
                this.isDragging = false;
            }
            // 点击检测：mousedown 在 canvas 上 + 位移 < 6px + 时长 < 500ms → 点击
            if (this._mouseDownPos) {
                const dx = e.clientX - this._mouseDownPos.x;
                const dy = e.clientY - this._mouseDownPos.y;
                const dist = Math.hypot(dx, dy);
                const dt = Date.now() - this._mouseDownTime;
                if (dist < 6 && dt < 500) {
                    this._handleCanvasClick(e.clientX, e.clientY);
                }
                this._mouseDownPos = null;
            }
        });

        // ── 滚轮缩放 ──
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.targetZoom += e.deltaY * 0.01;
            this.targetZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.targetZoom));
        }, { passive: false });

        // ── 触摸支持 ──
        canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                this._touchStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                this._touchStartTime = Date.now();
                this.isDragging = true;
                this.prevMouseX = e.touches[0].clientX;
                this.prevMouseY = e.touches[0].clientY;
                this.velocityX = 0;
                this.velocityY = 0;
                this.targetOrbitTheta = this.orbitTheta;
                this.targetOrbitPhi = this.orbitPhi;
            }
        });

        canvas.addEventListener('touchmove', (e) => {
            if (this.isDragging && e.touches.length === 1) {
                e.preventDefault();
                const dx = e.touches[0].clientX - this.prevMouseX;
                const dy = e.touches[0].clientY - this.prevMouseY;

                this.targetOrbitTheta += dx * this.dragSensitivity;
                this.targetOrbitPhi   += dy * this.dragSensitivity;
                this.targetOrbitPhi = Math.max(-1.4, Math.min(1.4, this.targetOrbitPhi));

                this.prevMouseX = e.touches[0].clientX;
                this.prevMouseY = e.touches[0].clientY;
            }
        }, { passive: false });

        canvas.addEventListener('touchend', (e) => {
            if (this.isDragging) {
                this.velocityX = (this.targetOrbitTheta - this.orbitTheta) * 0.5;
                this.velocityY = (this.targetOrbitPhi - this.orbitPhi) * 0.5;
                this.isDragging = false;
            }
            // 轻触检测：位移 < 8px + 时长 < 500ms → 点击
            if (this._touchStartPos && e.changedTouches.length > 0) {
                const t = e.changedTouches[0];
                const dx = t.clientX - this._touchStartPos.x;
                const dy = t.clientY - this._touchStartPos.y;
                const dist = Math.hypot(dx, dy);
                const dt = Date.now() - this._touchStartTime;
                if (dist < 8 && dt < 500) {
                    this._handleCanvasClick(t.clientX, t.clientY);
                }
                this._touchStartPos = null;
            }
        });
    }

    _onResize() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    }

    /**
     * 动画循环
     */
    _animate() {
        requestAnimationFrame(() => this._animate());

        const time = performance.now() * 0.001;

        // 平滑过渡
        this.transition += (this.targetTransition - this.transition) * 0.03;

        // ── 轨道旋转（拖拽 + 惯性）──
        if (!this.isDragging) {
            // 惯性衰减
            this.velocityX *= 0.94;
            this.velocityY *= 0.94;
            this.targetOrbitTheta += this.velocityX;
            this.targetOrbitPhi   += this.velocityY;
            this.targetOrbitPhi = Math.max(-1.4, Math.min(1.4, this.targetOrbitPhi));
        }

        // 平滑插值 orbit 角度
        this.orbitTheta += (this.targetOrbitTheta - this.orbitTheta) * 0.12;
        this.orbitPhi   += (this.targetOrbitPhi - this.orbitPhi) * 0.12;

        // 应用旋转到粒子组
        this.points.rotation.x = this.orbitPhi;
        this.points.rotation.y = this.orbitTheta;

        // ── 缩放（滚轮）──
        this.currentZoom += (this.targetZoom - this.currentZoom) * 0.08;
        this.camera.position.z = this.currentZoom;

        // ── 波浪对齐调制：正面(0,0)与反面(π,0)波浪=0，离开5°后逐渐恢复 ──
        // flatTheta = theta距最近平坦面（0或π）的角度距离
        const absTheta = Math.abs(this.orbitTheta);
        const flatTheta = Math.min(absTheta, Math.abs(Math.PI - absTheta));
        const deadZone = 0.0873;  // 5° in radians
        const adjTheta = Math.max(0, flatTheta - deadZone);
        const adjPhi   = Math.max(0, Math.abs(this.orbitPhi) - deadZone);
        const waveDeviation = Math.sqrt(adjTheta * adjTheta + adjPhi * adjPhi);
        this.material.uniforms.uWaveAlign.value = Math.min(waveDeviation * 3.0, 1.0);

        // 更新 uniforms
        this.material.uniforms.uTime.value = time;
        this.material.uniforms.uTransition.value = this.transition;
        this.material.uniforms.uWaveIntensity.value = this.waveIntensity;
        this.material.uniforms.uAudioLevel.value = this.audioLevel;

        // 渲染
        this.renderer.render(this.scene, this.camera);
    }

    /**
     * 处理 canvas 点击 — 判断是否击中粒子方形
     */
    _handleCanvasClick(clientX, clientY) {
        if (this.isClickOnSquare(clientX, clientY)) {
            this._squareClicked = true;
            if (this.onSquareClick) this.onSquareClick();
        }
    }

    /**
     * 判断屏幕坐标是否在粒子方形范围内（可触控边缘 = 方形边缘）
     * 使用射线投射，自动适配旋转、缩放、窗口尺寸变化
     */
    isClickOnSquare(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, this.camera);

        // 确保世界矩阵是最新的（包含轨道旋转 + 位置偏移）
        this.points.updateMatrixWorld();

        // 将射线变换到 points 的局部坐标系
        const invMatrix = new THREE.Matrix4().copy(this.points.matrixWorld).invert();
        const localOrigin = raycaster.ray.origin.clone().applyMatrix4(invMatrix);
        const localDir = raycaster.ray.direction.clone().transformDirection(invMatrix);

        // 方形平面在局部空间 z=0，求射线与该平面的交点
        if (Math.abs(localDir.z) < 1e-6) return false;
        const t = -localOrigin.z / localDir.z;
        if (t < 0) return false;

        const ix = localOrigin.x + t * localDir.x;
        const iy = localOrigin.y + t * localDir.y;

        const half = this.coverSize / 2;
        return ix >= -half && ix <= half && iy >= -half && iy <= half;
    }

    /**
     * 消费"方形被点击"标志（供 document click 处理器判断是否跳过收起逻辑）
     */
    consumeSquareClick() {
        const was = this._squareClicked;
        this._squareClicked = false;
        return was;
    }

    /**
     * 获取粒子方形在屏幕空间的包围盒（用于动态布局对齐）
     */
    getSquareScreenBounds() {
        const half = this.coverSize / 2;
        const corners = [
            new THREE.Vector3(-half, -half, 0),
            new THREE.Vector3(half, -half, 0),
            new THREE.Vector3(half, half, 0),
            new THREE.Vector3(-half, half, 0),
        ];

        this.points.updateMatrixWorld();

        const projected = corners.map(c => {
            const world = c.clone().applyMatrix4(this.points.matrixWorld);
            world.project(this.camera);
            return world;
        });

        const w = window.innerWidth;
        const h = window.innerHeight;

        const xs = projected.map(p => (p.x + 1) / 2 * w);
        const ys = projected.map(p => (1 - p.y) / 2 * h);

        return {
            left: Math.min(...xs),
            right: Math.max(...xs),
            top: Math.min(...ys),
            bottom: Math.max(...ys),
        };
    }

    /**
     * 销毁
     */
    dispose() {
        this.geometry.dispose();
        this.material.dispose();
        this.renderer.dispose();
    }
}
