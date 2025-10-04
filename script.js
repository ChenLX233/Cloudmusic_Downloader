/**
 * 音乐批量下载器主脚本（整合版）
 * 集成内容：
 * 1. 封面获取逻辑对齐版本 B：优先使用网易云返回的 song.al.picUrl / playlist.coverImgUrl
 * 2. 去除逐首调用第三方 tenapi 接口的旧逻辑，减少不必要的网络请求
 * 3. 新增 normalizeCover + coverCache；封面统一加尺寸参数（?param=200y200）便于控制
 * 4. 歌单封面缺失时异步获取第一首歌曲封面并回填（不阻塞主列表渲染）
 * 5. 修复“选择歌单后提示未选择”问题：使用事件委托监听动态插入的 playlist-checkbox
 * 6. 保留原 A 的批量下载（通过自建 /download POST）、进度显示、批量全选、歌单内部全选等功能
 * 7. 保持最小侵入修改，关注封面与歌单选择两大问题
 * 
 * 若需继续扩展：
 * - 可在 resolveSongCover 中加入后端代理封面接口兜底
 * - 可对 coverCache 增加 LRU 机制
 * - 可添加“刷新封面”按钮清空缓存后重绘
 */

// =======================
// 1. 全局变量区
// =======================
const itemsPerPage = 20;
let currentPage = 1;
let totalItems = 0;
let searchType = '1'; // '1'单曲, '1000'歌单
let searchKeywords = '';
let selectedSongs = [];
let playlistState = null;
let currentMode = 'initial';
let isDownloading = false;

let selectedSongsIds = [];         // 当前选中的单曲ID列表
let allSongsMap = {};              // 当前页所有单曲对象映射
let selectedPlaylistIds = [];      // 当前选中的歌单ID列表
let allPlaylistMap = {};           // 当前页所有歌单对象映射
let allSongIdsInPlaylist = [];     // 当前歌单所有歌曲ID（用于歌单详情页全选）
let lastSongList = [];             // 当前页歌曲列表缓存

const apiBase = 'https://musicapi.lxchen.cn';  // 自建API根地址（下载接口）
const cloudApi = 'https://163api.qijieya.cn';  // 云API（搜索/歌单数据）

// 封面相关
const DEFAULT_COVER = 'https://p2.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg';
const coverCache = new Map();

/**
 * 统一封面尺寸（网易云支持 param=WxH）
 * @param {string} url 
 * @param {number} size 
 * @returns {string}
 */
function normalizeCover(url, size = 200) {
    if (!url) return DEFAULT_COVER;
    if (url.includes('?param=')) return url;
    return `${url}?param=${size}y${size}`;
}

// =======================
// 2. UI显示/动画相关方法
// =======================

function showProgress(show, percent = 0, info = "") {
    const pc = document.getElementById('progress-container');
    const pb = document.getElementById('progress-bar');
    const pi = document.getElementById('progress-info');
    if (show) {
        pc.classList.remove('hidden');
        pb.style.width = percent + "%";
        pi.textContent = info;
    } else {
        pc.classList.add('hidden');
        pb.style.width = "0%";
        pi.textContent = "正在下载...";
    }
}

function showElements(show) {
    const optionsDiv = document.getElementById('options');
    const downloadBtn = document.getElementById('download-btn');
    if (show && currentMode === 'playlist') {
        optionsDiv.classList.remove('hidden');
        downloadBtn.textContent = '下载所选歌单';
        downloadBtn.onclick = downloadSelectedPlaylists;
    } else if (show && (currentMode === 'search' || currentMode === 'playlist-songs')) {
        optionsDiv.classList.remove('hidden');
        downloadBtn.textContent = '下载所选单曲';
        downloadBtn.onclick = downloadSelectedSongs;
    } else {
        optionsDiv.classList.add('hidden');
        downloadBtn.onclick = null;
    }
    document.getElementById('search-results').classList.toggle('hidden', !show);
    document.getElementById('pagination').classList.toggle('hidden', !show);
    document.getElementById('footer').classList.toggle('hidden', !show);
    document.getElementById('playlist-details').classList.toggle('hidden', !(show && currentMode === 'playlist-songs'));
    document.getElementById('batch-action-header').classList.toggle('hidden', !(show && (currentMode === 'playlist' || currentMode === 'search')));
}

function showLoading(show) {
    if (show) {
        document.getElementById('loading').classList.remove('hidden');
    } else if (!isDownloading) {
        document.getElementById('loading').classList.add('hidden');
    }
}

/**
 * 支持超时与重试的请求
 */
async function fetchWithRetry(url, options = {}, retries = 1, timeout = 15000) {
    for (let i = 0; i <= retries; i++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error(`HTTP 错误: ${response.status}`);
            const data = await response.json();
            if (data.code !== 200) throw new Error(`API 错误: ${data.message || '响应代码非200'}`);
            return data;
        } catch (error) {
            clearTimeout(timeoutId);
            if (i < retries && error.name !== 'AbortError') {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            throw error;
        }
    }
}

// =======================
// 3. 搜索与批量操作按钮渲染
// =======================

function renderBatchActionHeader() {
    const container = document.getElementById('batch-action-header');
    container.innerHTML = '';
    if (currentMode === 'playlist') {
        container.innerHTML = `
            <button id="select-all-playlist-btn" class="p-2 bg-blue-500 hover-effect rounded text-white">全选所有歌单</button>
            <button id="select-page-playlist-btn" class="p-2 bg-indigo-500 hover-effect rounded text-white">全选本页歌单</button>
        `;
        document.getElementById('select-all-playlist-btn').onclick = async () => {
            let allIds = [];
            let fullPlaylistMap = {};
            let total = totalItems;
            let perPage = 100;
            showLoading(true);
            for (let i = 0; i < total; i += perPage) {
                let data = await fetchWithRetry(
                    `${cloudApi}/cloudsearch?keywords=${encodeURIComponent(searchKeywords)}&type=1000&limit=${perPage}&offset=${i}`
                );
                let items = data?.result?.playlists || [];
                allIds = allIds.concat(items.map(p => String(p.id)));
                items.forEach(p => { fullPlaylistMap[String(p.id)] = p; });
            }
            showLoading(false);
            if (selectedPlaylistIds.length === allIds.length) {
                selectedPlaylistIds = [];
            } else {
                selectedPlaylistIds = [...allIds];
            }
            allPlaylistMap = fullPlaylistMap;
            displayPlaylists(playlistState.playlists);
        };
        document.getElementById('select-page-playlist-btn').onclick = () => {
            const resultsDiv = document.getElementById('search-results');
            const playlistCheckboxes = Array.from(resultsDiv.querySelectorAll('.playlist-checkbox'));
            const pageIds = playlistCheckboxes.map(cb => cb.dataset.id);
            const allPageSelected = pageIds.every(id => selectedPlaylistIds.includes(id));
            if (allPageSelected) {
                selectedPlaylistIds = selectedPlaylistIds.filter(id => !pageIds.includes(id));
            } else {
                pageIds.forEach(id => {
                    if (!selectedPlaylistIds.includes(id)) selectedPlaylistIds.push(id);
                });
            }
            displayPlaylists(playlistState.playlists);
        };
    }
    container.classList.remove('hidden');
}

// =======================
// 4. 搜索逻辑与分页
// =======================

document.getElementById('search-btn').addEventListener('click', async () => {
    searchType = document.getElementById('search-type').value;
    searchKeywords = document.getElementById('search-input').value.trim();
    if (!searchKeywords) {
        alert('请输入搜索关键词！');
        return;
    }
    currentPage = 1;
    selectedSongsIds = [];
    allSongsMap = {};
    selectedPlaylistIds = [];
    allPlaylistMap = {};
    allSongIdsInPlaylist = [];
    if (searchType === '1000' && /^\d{5,}$/.test(searchKeywords)) {
        currentMode = 'playlist-songs';
        await tryOpenPlaylistById(searchKeywords);
    } else {
        currentMode = searchType === '1' ? 'search' : 'playlist';
        showElements(true);
        searchMusic();
    }
});

async function searchMusic() {
    showLoading(true);
    const offset = (currentPage - 1) * itemsPerPage;
    try {
        const data = await fetchWithRetry(
            `${cloudApi}/cloudsearch?keywords=${encodeURIComponent(searchKeywords)}&type=${searchType}&limit=${itemsPerPage}&offset=${offset}`
        );
        showLoading(false);
        if (searchType === '1') {
            lastSongList = data.result.songs || [];
            displaySongs(lastSongList, 'search-results');
            totalItems = data.result.songCount || 0;
        } else {
            playlistState = { playlists: data.result.playlists || [], page: currentPage, keywords: searchKeywords };
            displayPlaylists(data.result.playlists || []);
            totalItems = data.result.playlistCount || 0;
        }
        renderPagination();
        renderBatchActionHeader();
        showElements(true);
    } catch (error) {
        showLoading(false);
        alert(error.name === 'AbortError' ? '请求超时，请稍后重试！' : '搜索失败，请检查网络！');
    }
}

async function tryOpenPlaylistById(playlistId) {
    showLoading(true);
    try {
        const data = await fetchWithRetry(`${cloudApi}/playlist/detail?id=${playlistId}`);
        if (data.playlist) {
            currentMode = 'playlist-songs';
            playlistState = { id: playlistId, name: data.playlist.name, trackCount: data.playlist.trackCount, page: currentPage };
            openPlaylist(playlistId, data.playlist.name, data.playlist.trackCount);
        } else {
            currentMode = 'playlist';
            searchMusic();
        }
    } catch (error) {
        showLoading(false);
        alert(error.name === 'AbortError' ? '请求超时，请稍后再试！' : '请求错误，请稍后再试');
        currentMode = 'playlist';
        searchMusic();
    }
}

// =======================
// 5. 封面获取与展示
// =======================

/**
 * 歌单封面获取：优先 coverImgUrl，缺失时取第一首歌曲 picUrl
 */
async function getPlaylistCover(playlist) {
    if (playlist.coverImgUrl) {
        return normalizeCover(playlist.coverImgUrl, 200);
    }
    if (playlist.id && playlist.trackCount > 0) {
        try {
            const detail = await fetchWithRetry(`${cloudApi}/playlist/track/all?id=${playlist.id}&limit=1&offset=0`);
            if (detail?.songs?.length) {
                const s = detail.songs[0];
                const url = s?.al?.picUrl;
                if (url) return normalizeCover(url, 200);
            }
        } catch (_) {}
    }
    return DEFAULT_COVER;
}

/**
 * 歌曲封面解析：直接取返回对象 al.picUrl（或 album.picUrl）
 */
function resolveSongCover(song) {
    const id = String(song.id);
    if (coverCache.has(id)) return coverCache.get(id);
    const url = normalizeCover(song?.al?.picUrl || song?.album?.picUrl || '', 200);
    coverCache.set(id, url);
    return url;
}

function displaySongs(songs, containerId) {
    renderBatchActionHeader();
    const resultsDiv = document.getElementById(containerId);
    resultsDiv.innerHTML = '';
    if (songs.length === 0) {
        resultsDiv.innerHTML = '<p>无结果</p>';
        return;
    }
    songs.forEach(song => {
        const idStr = String(song.id);
        const artists = song.ar ? song.ar.map(a => a.name).join(', ') : song.artists.map(a => a.name).join(', ');
        const checked = selectedSongsIds.includes(idStr) ? 'checked' : '';
        const coverUrl = resolveSongCover(song);

        const songDiv = document.createElement('div');
        songDiv.className = 'flex items-center p-2 border-b hover:bg-gray-50 hover:shadow-md transition-all duration-200';
        songDiv.innerHTML = `
            <input type="checkbox" class="song-checkbox w-5 h-5 mr-2 appearance-none border-2 border-gray-400 rounded checked:bg-blue-500 checked:border-blue-500 transition-all duration-200"
                data-id="${idStr}" ${checked}>
            <img src="${coverUrl}" alt="封面" class="w-12 h-12 rounded mr-2 object-cover">
            <span class="flex-1 cursor-pointer" data-id="${idStr}">
                ${song.name} <span class="text-gray-500 text-sm"> - ${artists}</span>
            </span>
            <button class="download-btn bg-green-500 text-white px-2 py-1 rounded hover:bg-green-600 hover:scale-105 transition-transform mr-2" data-id="${idStr}" data-name="${song.name} - ${artists}">
                <svg class="w-4 h-4 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>
                </svg>
            </button>
            <button class="preview-btn bg-blue-500 text-white px-2 py-1 rounded hover:bg-blue-600 hover:scale-105 transition-transform" data-id="${idStr}">
                <svg class="w-4 h-4 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.2A1 1 0 0010 9.768v4.464a1 1 0 001.555.832l3.197-2.2a1 1 0 000-1.664z"></path>
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
            </button>
        `;
        resultsDiv.appendChild(songDiv);
        allSongsMap[idStr] = { id: idStr, name: song.name + ' - ' + artists };
    });
    // 绑定歌曲复选框
    resultsDiv.querySelectorAll('.song-checkbox').forEach(cb => {
        cb.addEventListener('change', function() {
            const songId = this.dataset.id;
            if (this.checked) {
                if (!selectedSongsIds.includes(songId)) selectedSongsIds.push(songId);
            } else {
                selectedSongsIds = selectedSongsIds.filter(id => id !== songId);
            }
        });
    });
}

/**
 * 修复：不使用 forEach(async)。先同步渲染，缺封面时异步补齐
 */
function displayPlaylists(playlists) {
    renderBatchActionHeader();
    allPlaylistMap = {};
    const resultsDiv = document.getElementById('search-results');
    resultsDiv.innerHTML = '';
    if (!playlists || playlists.length === 0) {
        resultsDiv.innerHTML = '<p>无结果</p>';
        return;
    }

    playlists.forEach(playlist => {
        allPlaylistMap[playlist.id] = playlist;
        const checked = selectedPlaylistIds.includes(String(playlist.id)) ? 'checked' : '';
        const immediateCover = playlist.coverImgUrl ? normalizeCover(playlist.coverImgUrl, 200) : DEFAULT_COVER;

        const playlistDiv = document.createElement('div');
        playlistDiv.className = 'flex items-center p-2 border-b hover:bg-gray-50 hover:shadow-md cursor-pointer transition-all duration-200';
        playlistDiv.dataset.id = playlist.id;
        playlistDiv.dataset.name = playlist.name;
        playlistDiv.dataset.trackCount = playlist.trackCount;
        playlistDiv.innerHTML = `
            <input type="checkbox" class="playlist-checkbox w-5 h-5 mr-2" data-id="${playlist.id}" ${checked}>
            <img src="${immediateCover}" data-pl-cover="${playlist.id}" alt="封面" class="w-12 h-12 rounded mr-5 object-cover">
            <span class="flex-1 playlist-title-span">${playlist.name} <span class="text-gray-500 text-sm">(${playlist.trackCount}首)</span></span>
        `;

        playlistDiv.addEventListener('click', (event) => {
            if (event.target.closest('input[type="checkbox"]')) return;
            currentMode = 'playlist-songs';
            playlistState = { ...playlistState, id: playlist.id, name: playlist.name, trackCount: playlist.trackCount };
            currentPage = 1;
            selectedSongsIds = [];
            allSongsMap = {};
            openPlaylist(playlist.id, playlist.name, playlist.trackCount);
        });

        resultsDiv.appendChild(playlistDiv);

        if (!playlist.coverImgUrl && playlist.trackCount > 0) {
            (async () => {
                try {
                    const detail = await fetchWithRetry(`${cloudApi}/playlist/track/all?id=${playlist.id}&limit=1&offset=0`);
                    const first = detail?.songs?.[0];
                    const firstCover = first?.al?.picUrl;
                    if (firstCover) {
                        const imgEl = resultsDiv.querySelector(`img[data-pl-cover="${playlist.id}"]`);
                        if (imgEl) imgEl.src = normalizeCover(firstCover, 200);
                    }
                } catch (_) {}
            })();
        }
    });
}

// =======================
// 6. 分页
// =======================

function renderPagination() {
    const paginationDiv = document.getElementById('pagination');
    paginationDiv.innerHTML = '';
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    if (totalPages <= 15) {
        for (let i = 1; i <= totalPages; i++) {
            const pageLink = document.createElement('a');
            pageLink.href = '#';
            pageLink.textContent = i;
            pageLink.className = `px-3 py-1 rounded mx-1 ${i === currentPage ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`;
            pageLink.addEventListener('click', (e) => {
                e.preventDefault();
                currentPage = i;
                updatePagination();
            });
            paginationDiv.appendChild(pageLink);
        }
    } else {
        const scrollContainer = document.createElement('div');
        scrollContainer.className = 'overflow-x-auto whitespace-nowrap';
        for (let i = 1; i <= totalPages; i++) {
            const pageLink = document.createElement('a');
            pageLink.href = '#';
            pageLink.textContent = i;
            pageLink.className = `inline-block px-3 py-1 rounded mx-1 ${i === currentPage ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`;
            pageLink.addEventListener('click', (e) => {
                e.preventDefault();
                currentPage = i;
                updatePagination();
            });
            scrollContainer.appendChild(pageLink);
        }
        paginationDiv.appendChild(scrollContainer);
    }
}

function updatePagination() {
    if (currentMode === 'playlist') {
        searchMusic();
    } else if (currentMode === 'playlist-songs') {
        openPlaylist(playlistState.id, playlistState.name, playlistState.trackCount);
    } else {
        searchMusic();
    }
}

// =======================
// 7. 打开歌单 & 全选
// =======================

async function openPlaylist(playlistId, playlistName, trackCount) {
    showLoading(true);
    const offset = (currentPage - 1) * itemsPerPage;
    try {
        const data = await fetchWithRetry(`${cloudApi}/playlist/track/all?id=${playlistId}&limit=${itemsPerPage}&offset=${offset}`);
        showLoading(false);
        document.getElementById('playlist-title').textContent = playlistName;
        const selectAllBtn = document.getElementById('select-all-btn');
        selectAllBtn.removeEventListener('click', selectAllHandler);
        selectAllBtn.addEventListener('click', selectAllHandler);
        document.getElementById('back-btn').removeEventListener('click', backHandler);
        document.getElementById('back-btn').addEventListener('click', backHandler, { once: true });
        lastSongList = data.songs || [];
        displaySongs(lastSongList, 'search-results');
        totalItems = trackCount || data.songs.length;
        renderPagination();
        showElements(true);
    } catch (error) {
        showLoading(false);
        alert(error.name === 'AbortError' ? '加载歌单超时，请稍后重试！' : '获取歌单失败，请检查网络！');
    }
}

async function selectAllHandler() {
    if (!playlistState?.id) return;
    if (!allSongIdsInPlaylist.length) {
        let detail = await fetchWithRetry(`${cloudApi}/playlist/detail?id=${playlistState.id}`);
        let total = detail?.playlist?.trackCount || 0;
        let perPage = 1000;
        let allIds = [];
        for (let i = 0; i < total; i += perPage) {
            let tracks = await fetchWithRetry(`${cloudApi}/playlist/track/all?id=${playlistState.id}&limit=${perPage}&offset=${i}`);
            allIds = allIds.concat(tracks.songs.map(s => String(s.id)));
        }
        allSongIdsInPlaylist = allIds;
    }
    if (selectedSongsIds.length === allSongIdsInPlaylist.length) {
        selectedSongsIds = [];
    } else {
        selectedSongsIds = [...allSongIdsInPlaylist];
    }
    openPlaylist(playlistState.id, playlistState.name, playlistState.trackCount);
}

function backHandler() {
    currentMode = 'playlist';
    currentPage = playlistState.page || 1;
    searchKeywords = playlistState.keywords || searchKeywords;
    selectedSongsIds = [];
    allSongsMap = {};
    searchMusic();
    document.getElementById('playlist-details').classList.add('hidden');
}

// =======================
// 8. 下载相关
// =======================

async function downloadSelectedSongs() {
    selectedSongs = selectedSongsIds.map(id => allSongsMap[id]).filter(Boolean);
    if (selectedSongs.length === 0) {
        alert('请先选择歌曲！');
        return;
    }
    const quality = document.getElementById('quality-select').value || 'standard';
    isDownloading = true;
    showLoading(true);
    showProgress(true, 0, "正在准备...");
    try {
        const zip = new JSZip();
        const total = selectedSongs.length;
        let startTime = Date.now();
        for (let i = 0; i < total; i++) {
            const song = selectedSongs[i];
            const resp = await fetch(`${apiBase}/download`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: song.id, quality })
            });
            if (!resp.ok) continue;
            const contentType = resp.headers.get('Content-Type') || '';
            let ext = 'mp3';
            if (['lossless', 'hires', 'jyeffect'].includes(quality)) {
                if (/flac/i.test(contentType)) ext = 'flac';
                else if (/mp3/i.test(contentType)) ext = 'mp3';
                else if (/m4a|aac/i.test(contentType)) ext = 'm4a';
                else ext = 'flac';
            }
            let filename = `${song.name}.${ext}`;
            zip.file(filename, await resp.blob());

            let percent = Math.round((i + 1) / total * 100);
            let elapsed = (Date.now() - startTime) / 1000;
            let avg = elapsed / (i + 1);
            let remain = total - (i + 1);
            let est = Math.round(avg * remain);
            let info = `下载进度：${percent}% (${i + 1}/${total})`;
            if (remain > 0) info += `，预计剩余${est}秒`;
            showProgress(true, percent, info);
        }
        showProgress(true, 100, "正在打包...");
        const content = await zip.generateAsync({ type: 'blob' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(content);
        link.download = `音乐下载_${getNowTimeStr()}.zip`;
        link.click();
        isDownloading = false;
        showLoading(false);
        showProgress(false);
    } catch (error) {
        isDownloading = false;
        showLoading(false);
        showProgress(false);
        alert('批量下载失败，请检查网络！');
    }
}

async function downloadSelectedPlaylists() {
    if (!selectedPlaylistIds.length) {
        alert('请先选择歌单！');
        return;
    }
    const quality = document.getElementById('quality-select').value || 'standard';
    isDownloading = true;
    showLoading(true);
    showProgress(true, 0, "正在准备...");

    function safeName(name) {
        return name.replace(/[\\/:*?"<>|]/g, '_');
    }

    try {
        const masterZip = new JSZip();
        let totalPlaylists = selectedPlaylistIds.length;
        let playlistIdx = 0;

        for (const pid of selectedPlaylistIds) {
            playlistIdx++;
            let detail = await fetchWithRetry(`${cloudApi}/playlist/detail?id=${pid}`);
            let playlistName = detail?.playlist?.name || `歌单_${pid}`;
            let trackCount = detail?.playlist?.trackCount || 0;
            let allSongs = [];
            let perPage = 1000;
            for (let i = 0; i < trackCount; i += perPage) {
                let tracks = await fetchWithRetry(`${cloudApi}/playlist/track/all?id=${pid}&limit=${perPage}&offset=${i}`);
                allSongs = allSongs.concat(tracks.songs);
            }

            let playlistZip = new JSZip();
            let songIdx = 0;
            for (const song of allSongs) {
                songIdx++;
                let id = song.id;
                let songName = song.name + ' - ' + (song.ar ? song.ar.map(a => a.name).join(',') : '');
                const resp = await fetch(`${apiBase}/download`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id, quality })
                });
                if (!resp.ok) continue;
                const contentType = resp.headers.get('Content-Type') || '';
                let ext = 'mp3';
                if (['lossless', 'hires', 'jyeffect'].includes(quality)) {
                    if (/flac/i.test(contentType)) ext = 'flac';
                    else if (/mp3/i.test(contentType)) ext = 'mp3';
                    else if (/m4a|aac/i.test(contentType)) ext = 'm4a';
                    else ext = 'flac';
                } else {
                    ext = 'mp3';
                }
                let filename = safeName(songName) + '.' + ext;
                playlistZip.file(filename, await resp.blob());

                let percent = Math.round((playlistIdx - 1) / totalPlaylists * 100 + songIdx / allSongs.length * 100 / totalPlaylists);
                let info = `正在下载: ${playlistName} (${songIdx}/${allSongs.length}) 歌单进度：${playlistIdx}/${totalPlaylists}`;
                showProgress(true, percent, info);
            }
            let playlistZipBlob = await playlistZip.generateAsync({ type: 'blob' });
            masterZip.file(safeName(playlistName) + '.zip', playlistZipBlob);
        }
        showProgress(true, 100, "正在生成总ZIP包...");
        const masterZipBlob = await masterZip.generateAsync({ type: 'blob' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(masterZipBlob);
        link.download = `歌单打包_${getNowTimeStr()}.zip`;
        link.click();
        isDownloading = false;
        showLoading(false);
        showProgress(false);
    } catch (error) {
        isDownloading = false;
        showLoading(false);
        showProgress(false);
        alert('批量下载歌单失败，请检查网络！');
    }
}

// =======================
// 9. 事件委托（含歌单复选框修复）
// =======================

document.addEventListener('click', async (e) => {
    const previewDiv = document.getElementById('preview');
    // 关闭预览
    if (!e.target.closest('#preview') && !e.target.closest('.preview-btn') && !previewDiv.classList.contains('hidden')) {
        previewDiv.classList.add('hidden');
        previewDiv.innerHTML = '';
    }
    // 点击歌曲名区域切换勾选
    if (e.target.closest('span.cursor-pointer')) {
        const checkbox = e.target.closest('span').parentElement.querySelector('.song-checkbox');
        if (checkbox) {
            checkbox.checked = !checkbox.checked;
            const songId = checkbox.dataset.id;
            if (checkbox.checked) {
                if (!selectedSongsIds.includes(songId)) selectedSongsIds.push(songId);
            } else {
                selectedSongsIds = selectedSongsIds.filter(id => id !== songId);
            }
        }
    }
    // 预览
    if (e.target.closest('.preview-btn')) {
        const songId = e.target.closest('.preview-btn').dataset.id;
        const quality = document.getElementById('quality-select').value || 'standard';
        showLoading(true);
        try {
            const resp = await fetch(`${apiBase}/download`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: songId, quality })
            });
            if (!resp.ok) throw new Error('获取音频失败');
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            showLoading(false);
            previewDiv.classList.remove('hidden');
            previewDiv.style.position = 'fixed';
            previewDiv.style.bottom = '20px';
            previewDiv.style.right = '20px';
            previewDiv.style.width = '300px';
            previewDiv.style.zIndex = '1000';
            previewDiv.innerHTML = `
                <div class="bg-white p-4 rounded shadow-lg border">
                    <audio controls autoplay src="${url}" class="w-full mt-2"></audio>
                    <button class="close-preview mt-2 bg-red-500 text-white px-2 py-1 rounded hover:bg-red-600">关闭</button>
                </div>
            `;
            previewDiv.querySelector('.close-preview').addEventListener('click', () => {
                previewDiv.classList.add('hidden');
                previewDiv.innerHTML = '';
            });
        } catch (error) {
            showLoading(false);
            alert('预览失败，请检查网络！');
            previewDiv.classList.add('hidden');
        }
    }
    // 单首下载
    if (e.target.closest('.download-btn')) {
        const songId = e.target.closest('.download-btn').dataset.id;
        const fileNameOrigin = e.target.closest('.download-btn').dataset.name;
        const quality = document.getElementById('quality-select').value || 'standard';
        isDownloading = true;
        showLoading(true);
        showProgress(true, 0, "正在下载音频...");
        try {
            const resp = await fetch(`${apiBase}/download`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: songId, quality })
            });
            if (!resp.ok) throw new Error('下载失败');
            const contentType = resp.headers.get('Content-Type') || '';
            let ext = 'mp3';
            if (['lossless', 'hires', 'jyeffect'].includes(quality)) {
                if (/flac/i.test(contentType)) ext = 'flac';
                else if (/mp3/i.test(contentType)) ext = 'mp3';
                else if (/m4a|aac/i.test(contentType)) ext = 'm4a';
                else ext = 'flac';
            }
            const filename = `${fileNameOrigin}.${ext}`;
            const blob = await resp.blob();
            showProgress(true, 100, "准备保存...");
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = filename;
            link.click();
            setTimeout(() => showProgress(false), 700);
            isDownloading = false;
            showLoading(false);
        } catch (error) {
            isDownloading = false;
            showLoading(false);
            showProgress(false);
            alert('下载失败，请检查网络！');
        }
    }
});

// 歌单复选框事件委托（解决异步渲染导致无法选中问题）
document.getElementById('search-results').addEventListener('change', (e) => {
    if (e.target && e.target.classList.contains('playlist-checkbox')) {
        const pid = String(e.target.dataset.id);
        if (e.target.checked) {
            if (!selectedPlaylistIds.includes(pid)) selectedPlaylistIds.push(pid);
        } else {
            selectedPlaylistIds = selectedPlaylistIds.filter(id => id !== pid);
        }
    }
});

// =======================
// 10. 工具函数
// =======================

function getNowTimeStr() {
    const now = new Date();
    const Y = now.getFullYear();
    const M = String(now.getMonth() + 1).padStart(2, '0');
    const D = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    return `${Y}年${M}月${D}日${h}-${m}`;
}