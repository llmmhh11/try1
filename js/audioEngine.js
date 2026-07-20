/**
 * AudioEngine.js
 * 粒子音乐播放器 — 音频引擎
 * 
 * 功能：
 * 1. Web Audio API 音频播放
 * 2. 实时频谱分析（驱动粒子动画）
 * 3. 音量控制
 * 4. 播放列表管理
 * 5. 进度追踪
 */

import { trackStorage } from './storage.js';

export class AudioEngine {
    constructor() {
        this.audioContext = null;
        this.audioElement = null;
        this.source = null;
        this.analyser = null;
        this.gainNode = null;
        this.frequencyData = null;
        this.audioLevel = 0;
        this.smoothedLevel = 0;

        this.playlist = [];
        this.currentIndex = -1;
        this.volume = 0.7;
        this.isMuted = false;
        this.previousVolume = 0.7;
        this.isPlaying = false;

        // 回调
        this.onTimeUpdate = null;
        this.onDurationChange = null;
        this.onPlay = null;
        this.onPause = null;
        this.onEnded = null;
        this.onTrackChange = null;
    }

    /**
     * 初始化音频上下文（需要用户交互后调用）
     */
    init() {
        if (this.audioContext) return;

        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // 创建音频元素
        this.audioElement = new Audio();
        this.audioElement.crossOrigin = 'anonymous';

        // 创建音频节点
        this.source = this.audioContext.createMediaElementSource(this.audioElement);
        this.analyser = this.audioContext.createAnalyser();
        this.gainNode = this.audioContext.createGain();

        // 配置分析器
        this.analyser.fftSize = 256;
        this.analyser.smoothingTimeConstant = 0.8;
        this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);

        // 连接节点：source -> analyser -> gain -> destination
        this.source.connect(this.analyser);
        this.analyser.connect(this.gainNode);
        this.gainNode.connect(this.audioContext.destination);

        // 设置初始音量
        this.gainNode.gain.value = this.isMuted ? 0 : this.volume;

        // 事件监听
        this.audioElement.addEventListener('timeupdate', () => {
            if (this.onTimeUpdate) this.onTimeUpdate(this.audioElement.currentTime, this.audioElement.duration);
        });

        this.audioElement.addEventListener('durationchange', () => {
            if (this.onDurationChange) this.onDurationChange(this.audioElement.duration);
        });

        this.audioElement.addEventListener('ended', () => {
            this.isPlaying = false;
            if (this.onEnded) this.onEnded();
        });

        this.audioElement.addEventListener('play', () => {
            this.isPlaying = true;
            if (this.onPlay) this.onPlay();
        });

        this.audioElement.addEventListener('pause', () => {
            this.isPlaying = false;
            if (this.onPause) this.onPause();
        });
    }

    /**
     * 加载音频文件
     */
    async loadFiles(files) {
        const wasFirstLoad = this.playlist.length === 0;

        for (const file of files) {
            if (!file.type.startsWith('audio/')) continue;

            const url = URL.createObjectURL(file);

            // 尝试提取嵌入的专辑封面
            let coverArt = null;
            try {
                coverArt = await this._extractCoverArt(file);
            } catch (_) { /* 忽略提取失败 */ }

            // 尝试提取嵌入的歌词（本地）
            let lyrics = null;
            try {
                lyrics = await this._extractLyrics(file);
            } catch (_) { /* 忽略本地提取失败 */ }

            // 持久化到 IndexedDB（异步，不阻塞播放列表构建）
            const saveName = file.name.replace(/\.[^/.]+$/, '');
            const trackEntry = {
                name: saveName,
                url: url,
                file: file,
                duration: 0,
                coverArt: coverArt,
                lyrics: lyrics,
                _idbId: null,  // 等 saveTrack 完成后填入
            };
            this.playlist.push(trackEntry);

            const savePromise = file.arrayBuffer().then(buf => {
                return trackStorage.saveTrack(saveName, buf, coverArt, lyrics);
            }).then(id => {
                trackEntry._idbId = id;
                return id;
            }).catch(() => null);

            // 本地无歌词 → 异步联网搜索并回填（不阻塞导入流程）
            if (!lyrics) {
                this._fetchAndApplyLyrics(trackEntry, file.name, savePromise);
            }
        }

        if (wasFirstLoad && this.playlist.length > 0) {
            await this.playIndex(0);
        }

        if (this.onTrackChange) this.onTrackChange(this.playlist, this.currentIndex);
        return this.playlist;
    }

    /**
     * 异步从在线歌词库搜索并回填到指定曲目
     */
    async _fetchAndApplyLyrics(trackEntry, fileName, savePromise) {
        const meta = this._parseTrackNameForLyrics(fileName);
        const onlineLyrics = await this._fetchOnlineLyrics(meta.title, meta.artist);
        if (!onlineLyrics) return;

        // 如果已有歌词，只在"旧歌词无时间戳 + 新歌词有时间戳"时才替换
        if (trackEntry.lyrics) {
            const oldHasTime = AudioEngine.parseLRCWithTime(trackEntry.lyrics).hasTime;
            const newHasTime = AudioEngine.parseLRCWithTime(onlineLyrics).hasTime;
            if (oldHasTime || !newHasTime) return; // 旧歌词已有时间戳或新歌词也没时间戳 → 不替换
        }

        trackEntry.lyrics = onlineLyrics;
        console.log(`[歌词] ${fileName}: 在线歌词已回填`);

        // 等待 IndexedDB 保存完成，然后同步更新歌词
        let id = null;
        try {
            id = await savePromise;
        } catch (_) { /* 静默降级 */ }
        if (!id && trackEntry._idbId) id = trackEntry._idbId;

        if (id) {
            try {
                await trackStorage.updateTrackLyrics(id, onlineLyrics);
            } catch (_) { /* 静默降级 */ }
        }

        // 如果当前正在播放这首歌，触发歌词 UI 刷新
        const currentIdx = this.playlist.indexOf(trackEntry);
        if (currentIdx !== -1 && currentIdx === this.currentIndex && this.onLyricsUpdate) {
            this.onLyricsUpdate(this.playlist, this.currentIndex);
        }
    }

    /**
     * 从 IndexedDB 恢复播放列表（页面刷新后调用）
     * @returns {Promise<Array>} 恢复的播放列表
     */
    async loadFromStorage() {
        try {
            const records = await trackStorage.getAllTracks();
            if (records.length === 0) return [];

            for (const record of records) {
                // 从 ArrayBuffer 重建 Blob URL
                const blob = new Blob([record.audioBuffer]);
                const url = URL.createObjectURL(blob);
                const trackEntry = {
                    name: record.name,
                    url: url,
                    file: null,
                    duration: 0,
                    coverArt: record.coverArt || null,
                    lyrics: record.lyrics || null,
                    _idbId: record.id,       // IndexedDB 自增 ID，用于后续更新封面
                };
                this.playlist.push(trackEntry);

                // 无歌词 或 歌词无时间戳 → 异步联网搜索同步版本（不阻塞启动）
                const needSync = !trackEntry.lyrics ||
                    !AudioEngine.parseLRCWithTime(trackEntry.lyrics).hasTime;
                if (needSync) {
                    this._fetchAndApplyLyrics(trackEntry, record.name, Promise.resolve(record.id));
                }
            }

            return this.playlist;
        } catch (e) {
            console.warn('从 IndexedDB 恢复播放列表失败:', e);
            return [];
        }
    }

    /**
     * 更新指定曲目的封面（同步到播放列表 + IndexedDB）
     * @param {number} index - 播放列表索引
     * @param {string|null} coverArt - 封面 data URL
     */
    async updateTrackCoverArt(index, coverArt) {
        if (index < 0 || index >= this.playlist.length) return;
        const track = this.playlist[index];
        track.coverArt = coverArt;

        // 同步到 IndexedDB（如果有 ID）
        if (track._idbId) {
            try {
                await trackStorage.updateTrackCover(track._idbId, coverArt);
            } catch (_) { /* 静默降级 */ }
        }
    }

    /**
     * 从音频文件中提取嵌入的专辑封面（ID3v2 APIC 帧解析）
     * @param {File} file - 音频文件
     * @returns {Promise<String|null>} 封面 data URL，无封面返回 null
     */
    async _extractCoverArt(file) {
        // 只读取文件头部：ID3v2 标签通常在文件开头
        const headSize = Math.min(512 * 1024, file.size); // 最多读 512KB
        const buffer = await file.slice(0, headSize).arrayBuffer();
        const view = new DataView(buffer);

        // 检查 ID3v2 魔数
        if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) {
            return null; // "ID3" not found
        }

        const majorVersion = view.getUint8(3);
        const revision = view.getUint8(4);
        const flags = view.getUint8(5);

        // 解析 size（synchsafe integer: 每字节只用低7位）
        const size = (view.getUint8(6) << 21) | (view.getUint8(7) << 14) |
                     (view.getUint8(8) << 7)  | view.getUint8(9);

        let offset = 10; // 跳过 ID3 header

        // ID3v2.4 可能有扩展头
        if (majorVersion >= 3 && (flags & 0x40)) {
            const extSize = (view.getUint8(offset) << 21) | (view.getUint8(offset + 1) << 14) |
                            (view.getUint8(offset + 2) << 7) | view.getUint8(offset + 3);
            offset += extSize + 4;
        }

        const tagEnd = offset + size;

        // 遍历帧
        while (offset + 10 <= Math.min(tagEnd, buffer.byteLength)) {
            const frameId = String.fromCharCode(
                view.getUint8(offset), view.getUint8(offset + 1),
                view.getUint8(offset + 2), view.getUint8(offset + 3)
            );

            // 遇到 padding（全是0）则停止
            if (frameId === '\x00\x00\x00\x00') break;
            // 无效帧 ID
            if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

            let frameSize;
            if (majorVersion >= 4) {
                // ID3v2.4: synchsafe integer
                frameSize = (view.getUint8(offset + 4) << 21) | (view.getUint8(offset + 5) << 14) |
                            (view.getUint8(offset + 6) << 7)  | view.getUint8(offset + 7);
            } else {
                // ID3v2.3: normal integer
                frameSize = view.getUint32(offset + 4);
            }

            const frameFlags = view.getUint16(offset + 8);
            const frameDataStart = offset + 10;
            const frameDataEnd = frameDataStart + frameSize;

            if (frameId === 'APIC' && frameDataEnd <= buffer.byteLength) {
                // 解析 APIC 帧
                const enc = view.getUint8(frameDataStart); // text encoding
                let pos = frameDataStart + 1;

                // MIME type (null-terminated)
                let mimeType = '';
                while (pos < frameDataEnd) {
                    const byte = view.getUint8(pos++);
                    if (byte === 0) break;
                    mimeType += String.fromCharCode(byte);
                }

                // Picture type (1 byte, skip)
                const picType = view.getUint8(pos++);

                // Description (null-terminated, encoding-dependent)
                if (enc === 1 || enc === 2) {
                    // UTF-16: skip 2 bytes at a time until \0\0
                    while (pos + 1 < frameDataEnd) {
                        const b1 = view.getUint8(pos);
                        const b2 = view.getUint8(pos + 1);
                        pos += 2;
                        if (b1 === 0 && b2 === 0) break;
                    }
                } else {
                    // Latin1 / UTF-8: skip until \0
                    while (pos < frameDataEnd) {
                        if (view.getUint8(pos++) === 0) break;
                    }
                }

                // Remaining data = image binary
                const imgBytes = new Uint8Array(buffer, pos, frameDataEnd - pos);
                const blob = new Blob([imgBytes], { type: mimeType || 'image/jpeg' });
                return new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => resolve(null);
                    reader.readAsDataURL(blob);
                });
            }

            offset = frameDataEnd;
            if (frameSize === 0) break;
        }

        return null;
    }

    /**
     * 从音频文件中提取嵌入的歌词
     * 支持多种标签格式：
     *   - ID3v2 USLT / SYLT / TXXX(LYRICS)
     *   - Lyrics3 v2 (文件末尾 LYRICSBEGIN...LYRICSEND)
     *   - ID3v1 评论字段（文件末尾 TAG 标记）
     * @param {File} file - 音频文件
     * @returns {Promise<String|null>} 歌词文本，无歌词返回 null
     */
    async _extractLyrics(file) {
        // ── 阶段 1：扫描 ID3v2 头部 ──
        const headSize = Math.min(512 * 1024, file.size);
        let buffer = await file.slice(0, headSize).arrayBuffer();
        let view = new DataView(buffer);

        // 检查 ID3v2 魔数
        if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) {
            // 没有 ID3v2 → 跳到阶段 2（Lyrics3 / ID3v1）
            console.log(`[歌词] ${file.name}: 无 ID3v2 标签，尝试尾部标签`);
            return await this._extractLyricsFromTail(file);
        }

        const majorVersion = view.getUint8(3);
        const flags = view.getUint8(5);

        // 解析 tag size（synchsafe integer）
        const tagSize = (view.getUint8(6) << 21) | (view.getUint8(7) << 14) |
                        (view.getUint8(8) << 7)  | view.getUint8(9);

        // ID3 标签超出初始读取 → 补读完整
        const totalTagBytes = 10 + tagSize;
        if (totalTagBytes > buffer.byteLength && totalTagBytes <= file.size) {
            buffer = await file.slice(0, totalTagBytes).arrayBuffer();
            view = new DataView(buffer);
        }

        let offset = 10;
        const frameIds = [];
        let usltResult = null;
        let syltResult = null;
        let txxxResult = null;

        // ID3v2.3+ 扩展头
        if (majorVersion >= 3 && (flags & 0x40)) {
            const extSize = (view.getUint8(offset) << 21) | (view.getUint8(offset + 1) << 14) |
                            (view.getUint8(offset + 2) << 7) | view.getUint8(offset + 3);
            offset += extSize + 4;
        }

        const tagEnd = offset + tagSize;
        const safeEnd = Math.min(tagEnd, buffer.byteLength);

        while (offset + 10 <= safeEnd) {
            const frameId = String.fromCharCode(
                view.getUint8(offset), view.getUint8(offset + 1),
                view.getUint8(offset + 2), view.getUint8(offset + 3)
            );

            if (frameId === '\x00\x00\x00\x00') break;
            if (!/^[A-Z0-9]{4}$/.test(frameId)) { offset += 10; continue; }
            frameIds.push(frameId);

            let frameSize;
            if (majorVersion >= 4) {
                frameSize = (view.getUint8(offset + 4) << 21) | (view.getUint8(offset + 5) << 14) |
                            (view.getUint8(offset + 6) << 7)  | view.getUint8(offset + 7);
            } else {
                frameSize = view.getUint32(offset + 4);
            }

            // 防止帧大小异常导致无限循环
            if (frameSize < 0 || frameSize > buffer.byteLength - offset) break;

            const fdStart = offset + 10;
            const fdEnd = Math.min(fdStart + frameSize, buffer.byteLength);

            // ── USLT (非同步歌词) ──
            if (frameId === 'USLT' && fdEnd <= buffer.byteLength) {
                const enc = view.getUint8(fdStart);
                const lang = String.fromCharCode(
                    view.getUint8(fdStart + 1), view.getUint8(fdStart + 2), view.getUint8(fdStart + 3)
                );
                let pos = fdStart + 4; // 跳过 enc(1) + lang(3)

                // 跳过 null-terminated 描述符
                pos = this._skipNullTerminated(view, pos, fdEnd, enc);
                if (pos >= fdEnd) { offset = fdEnd; continue; }

                const text = this._decodeText(buffer, pos, fdEnd - pos, enc);
                if (text.trim().length > 0) {
                    usltResult = { text: text.trim(), lang, enc, lines: text.split(/\r?\n/).length };
                }
            }

            // ── SYLT (同步歌词，后备) ──
            else if (frameId === 'SYLT' && fdEnd <= buffer.byteLength) {
                const enc = view.getUint8(fdStart);
                let pos = fdStart + 1 + 3 + 1 + 1; // enc + lang + timefmt + ctype
                pos = this._skipNullTerminated(view, pos, fdEnd, enc);
                if (pos < fdEnd) {
                    const rawText = this._decodeText(buffer, pos, fdEnd - pos, enc);
                    const lines = rawText.split(/\r?\n/).filter(l => {
                        const c = l.trim();
                        return c.length > 1 && !/^[\x00\d]/.test(c);
                    });
                    if (lines.length > 0) syltResult = lines.join('\n');
                }
            }

            // ── TXXX (用户自定义文本，常存歌词) ──
            else if (frameId === 'TXXX' && fdEnd <= buffer.byteLength) {
                const enc = view.getUint8(fdStart);
                let pos = fdStart + 1;

                // 解析描述符
                const desc = this._readNullTerminated(view, pos, fdEnd, enc);
                if (desc) {
                    pos += this._nullTermLen(view, pos, fdEnd, enc);

                    // 描述为 "LYRICS" / "lyrics" / "UNSYNCED LYRICS" 等
                    const descUpper = desc.toUpperCase();
                    if (descUpper.includes('LYRIC') || descUpper.includes('LYRICS') ||
                        descUpper === 'UNSYNCEDLYRICS') {
                        if (pos < fdEnd) {
                            const text = this._decodeText(buffer, pos, fdEnd - pos, enc);
                            if (text.trim().length > 0) {
                                txxxResult = text.trim();
                            }
                        }
                    }
                }
            }

            offset = fdEnd;
            if (frameSize === 0) break;
        }

        // ── 优先级：USLT > TXXX > SYLT > 尾部标签 ──
        if (usltResult) {
            console.log(`[歌词] ${file.name}: USLT(${usltResult.lang}) ${usltResult.lines}行, enc=${usltResult.enc}`);
            return usltResult.text;
        }
        if (txxxResult) {
            console.log(`[歌词] ${file.name}: TXXX(LYRICS) ${txxxResult.split(/\r?\n/).length}行`);
            return txxxResult;
        }
        if (syltResult) {
            console.log(`[歌词] ${file.name}: SYLT ${syltResult.split(/\r?\n/).length}行`);
            return syltResult;
        }

        console.log(`[歌词] ${file.name}: ID3v2.${majorVersion}, 帧=[${frameIds.join(',')}], 无 USLT/SYLT/TXXX, 尝试尾部`);
        return await this._extractLyricsFromTail(file);
    }

    /**
     * 从文件尾部提取歌词（Lyrics3 v2 + ID3v1）
     */
    async _extractLyricsFromTail(file) {
        const tailSize = Math.min(64 * 1024, file.size); // 尾部 64KB 足够覆盖 Lyrics3 + ID3v1
        const buffer = await file.slice(-tailSize).arrayBuffer();
        const view = new DataView(buffer);
        const len = buffer.byteLength;

        // ── 先找 ID3v1 (末尾 128 字节 "TAG" 标记) ──
        let id3v1Offset = -1;
        if (len >= 128) {
            const tagStart = len - 128;
            if (view.getUint8(tagStart) === 0x54 && view.getUint8(tagStart + 1) === 0x41 &&
                view.getUint8(tagStart + 2) === 0x47) {
                id3v1Offset = tagStart;
            }
        }

        // ── 扫描 Lyrics3 v2 ──
        // Lyrics3 v2 格式：在 ID3v1 之前，以 "LYRICSBEGIN" (11 字节) 开头，以 "LYRICSEND" (9 字节) 结尾
        // 大小字段在 LYRICSBEGIN 之前 6 字节
        // 实际扫描：从 ID3v1 之前的位置往前找 LYRICSBEGIN
        const searchStart = id3v1Offset > 0 ? id3v1Offset : len;
        let lyrics3Text = null;

        // 在 buffer 中搜索 "LYRICSBEGIN" 标记
        const marker = new Uint8Array([0x4C, 0x59, 0x52, 0x49, 0x43, 0x53, 0x42, 0x45, 0x47, 0x49, 0x4E]);
        let lyrics3Pos = -1;
        for (let i = 0; i <= Math.min(searchStart - 11, len - 11); i++) {
            let match = true;
            for (let j = 0; j < 11; j++) {
                if (view.getUint8(i + j) !== marker[j]) { match = false; break; }
            }
            if (match) { lyrics3Pos = i; break; }
        }

        if (lyrics3Pos >= 0) {
            // LYRICSBEGIN 之后直接就是歌词文本（ISO-8859-1），以 "LYRICSEND" 结尾
            const lyricsStart = lyrics3Pos + 11;
            const endMarker = new Uint8Array([0x4C, 0x59, 0x52, 0x49, 0x43, 0x53, 0x45, 0x4E, 0x44]);
            let lyricsEndPos = -1;
            for (let i = lyricsStart; i <= len - 9; i++) {
                let match = true;
                for (let j = 0; j < 9; j++) {
                    if (view.getUint8(i + j) !== endMarker[j]) { match = false; break; }
                }
                if (match) { lyricsEndPos = i; break; }
            }

            if (lyricsEndPos > lyricsStart) {
                const textBytes = new Uint8Array(buffer, lyricsStart, lyricsEndPos - lyricsStart);
                // Lyrics3 v2 使用 ISO-8859-1，但现代工具常用 UTF-8
                let text = '';
                // 先尝试 UTF-8
                try {
                    text = new TextDecoder('utf-8', { fatal: true }).decode(textBytes);
                } catch (_) {
                    // 退回 ISO-8859-1
                    text = Array.from(textBytes, b => String.fromCharCode(b)).join('');
                }
                lyrics3Text = text.trim();
            }
        }

        // ── ID3v1 评论字段 ──
        let id3v1Lyrics = null;
        if (id3v1Offset > 0 && !lyrics3Text) {
            // 评论字段在 ID3v1 的 offset 97-126（30 字节）
            const commentBytes = new Uint8Array(buffer, id3v1Offset + 97, 30);
            // 去掉尾部 0x00 和空格
            let endIdx = commentBytes.length;
            while (endIdx > 0 && (commentBytes[endIdx - 1] === 0 || commentBytes[endIdx - 1] === 0x20)) endIdx--;
            if (endIdx > 2) {
                id3v1Lyrics = Array.from(commentBytes.slice(0, endIdx), b => String.fromCharCode(b)).join('');
                // ID3v1 使用 ISO-8859-1，中文会乱码，检测是否为有效文本
                if (id3v1Lyrics.length > 2 && !/^[\x00-\x08\x0B\x0C\x0E-\x1F]+$/.test(id3v1Lyrics) && id3v1Lyrics.length < 2000) {
                    // 可能是歌词但不一定是中文友好的编码
                } else {
                    id3v1Lyrics = null; // 不是有效文本
                }
            } else {
                id3v1Lyrics = null;
            }
        }

        // ── 返回结果 ──
        if (lyrics3Text && lyrics3Text.length > 2) {
            console.log(`[歌词] ${file.name}: Lyrics3 v2 ${lyrics3Text.split(/\r?\n/).length}行`);
            return lyrics3Text;
        }
        if (id3v1Lyrics) {
            console.log(`[歌词] ${file.name}: ID3v1 评论字段 ${id3v1Lyrics.split(/\r?\n/).length}行`);
            return id3v1Lyrics;
        }

        console.log(`[歌词] ${file.name}: 尾部标签也无歌词`);
        return null;
    }

    /**
     * 从文件名解析歌曲标题和艺术家，用于在线歌词搜索
     * 支持格式："屋顶.mp3" / "周杰伦 - 屋顶.mp3" / "周杰伦-屋顶.mp3"
     */
    _parseTrackNameForLyrics(fileName) {
        let base = fileName.replace(/\.[^/.]+$/, '').trim();
        // 去掉常见垃圾前缀：数字序号、 disc track 标记等
        base = base.replace(/^\s*\d+[\.\s_-]+/, '').trim();

        // 尝试 "艺术家 - 标题" 或 "艺术家-标题"
        const m = base.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (m) {
            return { artist: m[1].trim(), title: m[2].trim() };
        }
        return { artist: '', title: base };
    }

    /**
     * 通过 LRCLIB 在线歌词库搜索歌词
     * 先尝试精确参数搜索，无结果再回退到模糊搜索
     * @param {string} title - 歌曲标题
     * @param {string} artist - 艺术家（可选）
     * @returns {Promise<String|null>} plain lyrics 或 null
     */
    async _fetchOnlineLyrics(title, artist = '') {
        if (!title || title.length < 1) return null;

        // 1) 精确搜索：track_name + artist_name
        if (artist) {
            const params = new URLSearchParams({
                track_name: title,
                artist_name: artist,
            });
            const result = await this._searchLrclib(params, title, artist);
            if (result) return result;
        }

        // 2) 模糊搜索：q = artist + title
        const q = `${artist} ${title}`.trim();
        const params = new URLSearchParams({ q });
        const result = await this._searchLrclib(params, title, artist);
        if (result) return result;

        console.log(`[歌词] 在线搜索无结果: ${title}`);
        return null;
    }

    /**
     * 调用 LRCLIB API 并挑选最佳匹配歌词
     */
    async _searchLrclib(params, title, artist) {
        const url = `https://lrclib.net/api/search?${params.toString()}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);

        try {
            const res = await fetch(url, {
                method: 'GET',
                signal: controller.signal,
                headers: { 'Accept': 'application/json' }
            });
            clearTimeout(timer);

            if (!res.ok) {
                console.log(`[歌词] 在线搜索 HTTP ${res.status}: ${title}`);
                return null;
            }

            const data = await res.json();
            if (!Array.isArray(data) || data.length === 0) return null;

            const lowerTitle = title.toLowerCase();
            const lowerArtist = artist.toLowerCase();

            // 优先精确匹配：标题和艺术家都符合
            for (const item of data) {
                const trackName = (item.trackName || '').toLowerCase();
                const artistName = (item.artistName || '').toLowerCase();
                const hasPlain = item.plainLyrics && item.plainLyrics.trim().length > 10;
                const hasSync = item.syncedLyrics && item.syncedLyrics.trim().length > 10;

                if (!hasPlain && !hasSync) continue;

                if (artist && !artistName.includes(lowerArtist) && !lowerArtist.includes(artistName)) {
                    continue;
                }
                if (trackName.includes(lowerTitle) || lowerTitle.includes(trackName)) {
                    // 优先返回同步歌词原文（带 [mm:ss.xx] 时间戳），前端解析逐字放大
                    const text = hasSync ? item.syncedLyrics.trim() : item.plainLyrics.trim();
                    console.log(`[歌词] 在线匹配成功: ${item.artistName || artist} - ${item.trackName || title}, ${text.split(/\r?\n/).length}行, ${hasSync ? '同步' : '纯文本'}`);
                    return text;
                }
            }

            // fallback：取第一个有歌词的（优先同步歌词）
            for (const item of data) {
                if (item.syncedLyrics && item.syncedLyrics.trim().length > 10) {
                    const text = item.syncedLyrics.trim();
                    console.log(`[歌词] 在线匹配(fallback sync): ${item.artistName || artist} - ${item.trackName || title}, ${text.split(/\r?\n/).length}行`);
                    return text;
                }
                if (item.plainLyrics && item.plainLyrics.trim().length > 10) {
                    const text = item.plainLyrics.trim();
                    console.log(`[歌词] 在线匹配(fallback): ${item.artistName || artist} - ${item.trackName || title}, ${text.split(/\r?\n/).length}行`);
                    return text;
                }
            }

            return null;
        } catch (err) {
            console.warn(`[歌词] 在线搜索失败: ${title}`, err.name || err.message);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 跳过 null-terminated 字符串（按 enc 编码: 0=ISO, 1=UTF-16LE, 2=UTF-16BE, 3=UTF-8）
     * 返回跳过后的位置
     */
    _skipNullTerminated(view, start, end, enc) {
        let pos = start;
        if (enc === 1 || enc === 2) {
            while (pos + 1 < end) {
                if (view.getUint8(pos) === 0 && view.getUint8(pos + 1) === 0) { pos += 2; break; }
                pos += 2;
            }
        } else {
            while (pos < end) {
                if (view.getUint8(pos++) === 0) break;
            }
        }
        return pos;
    }

    /**
     * 读取 null-terminated 字符串（返回解码后的文本，不含 null）
     */
    _readNullTerminated(view, start, end, enc) {
        let pos = start;
        const bytes = [];
        if (enc === 1 || enc === 2) {
            while (pos + 1 < end) {
                const b1 = view.getUint8(pos), b2 = view.getUint8(pos + 1);
                if (b1 === 0 && b2 === 0) break;
                bytes.push(b1, b2);
                pos += 2;
            }
        } else {
            while (pos < end) {
                const b = view.getUint8(pos++);
                if (b === 0) break;
                bytes.push(b);
            }
        }
        if (bytes.length === 0) return '';
        const buf = new Uint8Array(bytes);
        if (enc === 1) return new TextDecoder('utf-16le').decode(buf);
        if (enc === 2) return new TextDecoder('utf-16be').decode(buf);
        if (enc === 3) return new TextDecoder('utf-8').decode(buf);
        return Array.from(bytes, b => String.fromCharCode(b)).join('');
    }

    /**
     * 计算 null-terminated 字符串占用的字节数（含结尾 null）
     */
    _nullTermLen(view, start, end, enc) {
        let pos = start;
        if (enc === 1 || enc === 2) {
            while (pos + 1 < end) {
                if (view.getUint8(pos) === 0 && view.getUint8(pos + 1) === 0) { pos += 2; break; }
                pos += 2;
            }
        } else {
            while (pos < end) {
                if (view.getUint8(pos++) === 0) break;
            }
        }
        return pos - start;
    }

    /**
     * 按编码解码文本
     */
    _decodeText(buffer, offset, length, enc) {
        const bytes = new Uint8Array(buffer, offset, length);
        if (enc === 1) return new TextDecoder('utf-16le').decode(bytes).replace(/^\uFEFF/, '');
        if (enc === 2) return new TextDecoder('utf-16be').decode(bytes).replace(/^\uFEFF/, '');
        if (enc === 3) return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
        return Array.from(bytes, b => String.fromCharCode(b)).join('');
    }

    /**
     * 播放指定索引
     */
    async playIndex(index) {
        if (index < 0 || index >= this.playlist.length) return;

        this.init();

        const track = this.playlist[index];
        this.currentIndex = index;
        this.audioElement.src = track.url;
        this.audioElement.load();

        // 恢复音频上下文（浏览器自动暂停策略）
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        try {
            await this.audioElement.play();
            if (this.onTrackChange) this.onTrackChange(this.playlist, this.currentIndex);
        } catch (e) {
            console.warn('播放失败:', e);
            throw e;
        }
    }

    /**
     * 播放/暂停切换
     */
    async togglePlay() {
        if (this.currentIndex === -1) return;

        this.init();

        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        if (this.audioElement.paused) {
            await this.audioElement.play();
        } else {
            this.audioElement.pause();
        }
    }

    /**
     * 上一首
     */
    async prev() {
        if (this.playlist.length === 0) return;
        const index = this.currentIndex > 0 ? this.currentIndex - 1 : this.playlist.length - 1;
        await this.playIndex(index);
    }

    /**
     * 下一首
     */
    async next() {
        if (this.playlist.length === 0) return;
        const index = this.currentIndex < this.playlist.length - 1 ? this.currentIndex + 1 : 0;
        await this.playIndex(index);
    }

    /**
     * 跳转到指定时间
     */
    seek(time) {
        if (this.audioElement && this.audioElement.duration) {
            this.audioElement.currentTime = time;
        }
    }

    /**
     * 设置音量
     */
    setVolume(value) {
        this.volume = Math.max(0, Math.min(1, value));
        if (this.gainNode) {
            this.gainNode.gain.value = this.isMuted ? 0 : this.volume;
        }
    }

    /**
     * 静音切换
     */
    toggleMute() {
        this.isMuted = !this.isMuted;
        if (this.isMuted) {
            this.previousVolume = this.volume;
            if (this.gainNode) this.gainNode.gain.value = 0;
        } else {
            if (this.gainNode) this.gainNode.gain.value = this.volume;
        }
        return this.isMuted;
    }

    /**
     * 获取当前音频电平（用于驱动粒子）
     * 通过分析频谱数据计算综合音量
     */
    getAudioLevel() {
        if (!this.analyser || !this.isPlaying) {
            this.smoothedLevel *= 0.95; // 衰减
            return this.smoothedLevel;
        }

        this.analyser.getByteFrequencyData(this.frequencyData);

        // 计算低频（鼓点）和中频的平均值
        const lowFreqEnd = Math.floor(this.frequencyData.length * 0.15);
        const midFreqEnd = Math.floor(this.frequencyData.length * 0.6);

        let lowSum = 0;
        let midSum = 0;

        for (let i = 0; i < lowFreqEnd; i++) {
            lowSum += this.frequencyData[i];
        }
        for (let i = lowFreqEnd; i < midFreqEnd; i++) {
            midSum += this.frequencyData[i];
        }

        const lowAvg = lowSum / lowFreqEnd / 255;
        const midAvg = midSum / (midFreqEnd - lowFreqEnd) / 255;

        // 综合：低频权重更高（鼓点感更强）
        this.audioLevel = lowAvg * 0.7 + midAvg * 0.3;

        // 平滑处理
        this.smoothedLevel += (this.audioLevel - this.smoothedLevel) * 0.3;

        return this.smoothedLevel;
    }

    /**
     * 获取频谱数据（用于扩展可视化）
     */
    getFrequencyData() {
        if (!this.analyser) return null;
        this.analyser.getByteFrequencyData(this.frequencyData);
        return this.frequencyData;
    }

    /**
     * 从播放列表中删除指定索引的歌曲（同步 IndexedDB）
     * @param {number} index - 要删除的播放列表索引
     */
    async removeTrack(index) {
        if (index < 0 || index >= this.playlist.length) return;

        const track = this.playlist[index];

        // 从 IndexedDB 删除
        if (track._idbId) {
            try { await trackStorage.deleteTrack(track._idbId); } catch (_) { /* 静默降级 */ }
        }

        // 释放 Blob URL
        if (track.url && track.url.startsWith('blob:')) {
            URL.revokeObjectURL(track.url);
        }

        // 从播放列表移除
        this.playlist.splice(index, 1);

        // 调整 currentIndex
        if (this.playlist.length === 0) {
            // 没有歌曲了
            this.currentIndex = -1;
            if (this.audioElement) {
                this.audioElement.pause();
                this.audioElement.src = '';
            }
            this.isPlaying = false;
            if (this.onPause) this.onPause();
        } else if (index < this.currentIndex) {
            // 删除了当前播放之前的一首，索引前移
            this.currentIndex -= 1;
        } else if (index === this.currentIndex) {
            // 删除了正在播放的歌曲
            // 尝试播放同一位置的新歌曲（原来的下一首），否则播最后一首
            const newIndex = Math.min(index, this.playlist.length - 1);
            if (this.onTrackChange) this.onTrackChange(this.playlist, newIndex);
            // 异步切歌
            try {
                await this.playIndex(newIndex);
            } catch (_) {
                this.currentIndex = newIndex;
                if (this.onTrackChange) this.onTrackChange(this.playlist, this.currentIndex);
            }
            return; // playIndex 已经触发了 onTrackChange
        }
        // else: index > currentIndex，不影响

        if (this.onTrackChange) this.onTrackChange(this.playlist, this.currentIndex);
    }

    /**
     * 获取当前播放信息
     */
    getCurrentTrack() {
        if (this.currentIndex === -1) return null;
        return this.playlist[this.currentIndex];
    }

    /**
     * 获取当前时间
     */
    getCurrentTime() {
        return this.audioElement ? this.audioElement.currentTime : 0;
    }

    /**
     * 获取总时长
     */
    getDuration() {
        return this.audioElement ? this.audioElement.duration : 0;
    }

    /**
     * 更新指定曲目的歌词（同步到播放列表 + IndexedDB）
     * @param {number} index - 播放列表索引
     * @param {string|null} lyrics - 歌词文本
     */
    async updateTrackLyrics(index, lyrics) {
        if (index < 0 || index >= this.playlist.length) return;
        const track = this.playlist[index];
        track.lyrics = lyrics;

        if (track._idbId) {
            try { await trackStorage.updateTrackLyrics(track._idbId, lyrics); }
            catch (_) { /* 静默降级 */ }
        }
    }

    /**
     * 解析 LRC 歌词，保留时间戳信息
     * 支持多种格式：[mm:ss.xx]、[mm:ss.xxx]、[mm:ss]、多时间标签同行
     * @param {string} text - LRC 文件内容或纯文本歌词
     * @returns {{lines: Array<{time: number|null, text: string}>, hasTime: boolean}}
     */
    static parseLRCWithTime(text) {
        const lines = [];
        const tagRegex = /\[(\d{1,3}):(\d{1,2}(?:\.\d+)?)\]/g;

        for (const raw of text.split(/\r?\n/)) {
            const times = [];
            let match;
            tagRegex.lastIndex = 0;
            while ((match = tagRegex.exec(raw)) !== null) {
                times.push(parseInt(match[1]) * 60 + parseFloat(match[2]));
            }
            const content = raw.replace(tagRegex, '').trim();
            if (content.length === 0) continue;

            if (times.length > 0) {
                for (const t of times) {
                    lines.push({ time: t, text: content });
                }
            } else {
                lines.push({ time: null, text: content });
            }
        }

        // 按时间排序（null 排最后）
        lines.sort((a, b) => {
            if (a.time === null) return 1;
            if (b.time === null) return -1;
            return a.time - b.time;
        });

        const hasTime = lines.some(l => l.time !== null);
        return { lines, hasTime };
    }

    /**
     * 解析 LRC 歌词文件（纯文本，去时间戳）— 向后兼容
     * @param {string} text - LRC 文件内容
     * @returns {string} 提取的纯歌词文本（按行）
     */
    static parseLRC(text) {
        const { lines } = AudioEngine.parseLRCWithTime(text);
        if (lines.length === 0) {
            return text.split(/\r?\n/).filter(l => l.trim().length > 0).join('\n');
        }
        return lines.map(l => l.text).join('\n');
    }

    /**
     * 格式化时间
     */
    static formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }
}
