/**
 * 音乐批量下载器主脚本（已彻底去除“全选本页单曲”按钮）
 * BY Enashpinal
 * 已加入非常详细的中文注释，便于理解和维护。
 */

/* ==============================
   1. 全局变量区
   ============================== */
// 每页显示条目数（歌单/单曲分页用）
const itemsPerPage = 20;
// 当前分页页码
let currentPage = 1;
// 搜索到的总条目数（当前分页用）
let totalItems = 0;
// 搜索类型 '1'表示单曲，'1000'表示歌单
let searchType = '1';
// 用户输入的搜索关键词
let searchKeywords = '';
// 批量下载时选中的歌曲对象列表
let selectedSongs = [];
// 当前歌单相关状态信息（如ID、名称、歌曲总数、页码等）
let playlistState = null;
// 页面当前模式（'search'、'playlist'、'playlist-songs'等）
let currentMode = 'initial';
// 是否正在下载（用于防止操作冲突）
let isDownloading = false;

// 选中的歌曲ID列表（用于多选/批量下载）
let selectedSongsIds = [];
// 所有当前页歌曲对象的映射表（id -> 歌曲对象）
let allSongsMap = {};
// 选中的歌单ID列表（用于多选/批量下载歌单）
let selectedPlaylistIds = [];
// 所有当前页歌单对象的映射表（id -> 歌单对象）
let allPlaylistMap = {};
// 当前歌单详情页全部歌曲ID（用于歌单全选）
let allSongIdsInPlaylist = [];
// 当前页的歌曲列表缓存（用于刷新视图时避免重复请求）
let lastSongList = [];

// API接口基础地址（单曲下载和预览用）
const apiBase = 'https://api.lxchen.cn/api';
// 云API地址（搜索/歌单相关操作用）
const cloudApi = 'https://163api.qijieya.cn';

/* ==============================
   2. 页面状态与交互方法
   ============================== */

/**
 * 显示或隐藏下载进度条，控制进度百分比和说明文本
 * @param {boolean} show - 是否显示进度条
 * @param {number} percent - 当前进度百分比（0-100）
 * @param {string} info - 进度相关说明文本
 */
function showProgress(show, percent = 0, info = "") {
    const pc = document.getElementById('progress-container');
    const pb = document.getElementById('progress-bar');
    const pi = document.getElementById('progress-info');
    if (show) {
        pc.classList.remove('hidden');        // 显示进度条容器
        pb.style.width = percent + "%";       // 设置进度条长度
        pi.textContent = info;                // 设置进度说明文本
    } else {
        pc.classList.add('hidden');           // 隐藏进度条容器
        pb.style.width = "0%";
        pi.textContent = "正在下载...";       // 默认说明
    }
}

/**
 * 显示或隐藏页面各个区域（如选项区、结果区、分页、歌单详情区等）
 * @param {boolean} show - 是否显示相关区域
 */
function showElements(show) {
    document.getElementById('options').classList.toggle('hidden', !show);
    document.getElementById('search-results').classList.toggle('hidden', !show);
    document.getElementById('pagination').classList.toggle('hidden', !show);
    document.getElementById('footer').classList.toggle('hidden', !show);
    document.getElementById('playlist-details').classList.toggle('hidden', !(show && currentMode === 'playlist-songs'));
    document.getElementById('batch-action-header').classList.toggle('hidden', !(show && (currentMode === 'playlist' || currentMode === 'search')));
}

/**
 * 显示或隐藏加载中的动画（如遮罩/提示）
 * @param {boolean} show - 是否显示加载动画
 */
function showLoading(show) {
    if (show) {
        document.getElementById('loading').classList.remove('hidden');
    } else if (!isDownloading) {
        document.getElementById('loading').classList.add('hidden');
    }
}

/**
 * 支持超时与重试的异步请求方法
 * @param {string} url - 请求地址
 * @param {object} options - fetch配置
 * @param {number} retries - 最大重试次数
 * @param {number} timeout - 超时时长(ms)
 * @returns {Promise<object>} - 请求返回的JSON数据
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
            // 非超时且还有重试次数则重试
            if (i < retries && error.name !== 'AbortError') {
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
            throw error;
        }
    }
}

/* ==============================
   3. 搜索与列表渲染相关
   ============================== */

/**
 * 搜索按钮点击事件，初始化状态并发起搜索/跳转歌单
 */
document.getElementById('search-btn').addEventListener('click', async () => {
    searchType = document.getElementById('search-type').value;
    searchKeywords = document.getElementById('search-input').value.trim();
    if (!searchKeywords) {
        alert('请输入搜索关键词！');
        return;
    }
    // 每次搜索时清空所有选中和缓存
    currentPage = 1;
    selectedSongsIds = [];
    allSongsMap = {};
    selectedPlaylistIds = [];
    allPlaylistMap = {};
    allSongIdsInPlaylist = [];
    // 如果为歌单ID直接跳转详情页
    if (searchType === '1000' && /^\d{5,}$/.test(searchKeywords)) {
        currentMode = 'playlist-songs';
        await tryOpenPlaylistById(searchKeywords);
    } else {
        currentMode = searchType === '1' ? 'search' : 'playlist';
        showElements(true);
        searchMusic();
    }
});

/**
 * 搜索主方法，根据类型请求单曲/歌单列表并渲染
 * 单曲模式缓存当前页数据到lastSongList
 */
async function searchMusic() {
    showLoading(true);
    const offset = (currentPage - 1) * itemsPerPage;
    try {
        const data = await fetchWithRetry(
            `${cloudApi}/cloudsearch?keywords=${encodeURIComponent(searchKeywords)}&type=${searchType}&limit=${itemsPerPage}&offset=${offset}`
        );
        showLoading(false);
        if (searchType === '1') {
            // 单曲模式：渲染单曲列表
            lastSongList = data.result.songs || [];
            displaySongs(lastSongList, 'search-results');
            totalItems = data.result.songCount || 0;
        } else {
            // 歌单模式：渲染歌单列表
            playlistState = { playlists: data.result.playlists || [], page: currentPage, keywords: searchKeywords };
            displayPlaylists(data.result.playlists || []);
            totalItems = data.result.playlistCount || 0;
        }
        renderPagination();
        renderBatchActionHeader();
    } catch (error) {
        showLoading(false);
        alert(error.name === 'AbortError' ? '请求超时，请稍后重试！' : '搜索失败，请检查网络！');
    }
}

/**
 * 跳转歌单详情页（通过歌单ID），若找不到则重新搜索歌单列表
 * @param {string} playlistId - 歌单ID
 */
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

/**
 * 渲染批量操作按钮区，只保留歌单相关（彻底去除全选本页单曲按钮）
 * 歌单页面提供“全选所有歌单”“全选本页歌单”按钮及逻辑
 */
function renderBatchActionHeader() {
    const container = document.getElementById('batch-action-header');
    container.innerHTML = '';
    if (currentMode === 'playlist') {
        // 仅歌单页面有批量操作按钮
        container.innerHTML = `
            <button id="select-all-playlist-btn" class="p-2 bg-blue-500 hover-effect rounded text-white">全选所有歌单</button>
            <button id="select-page-playlist-btn" class="p-2 bg-indigo-500 hover-effect rounded text-white">全选本页歌单</button>
        `;
        // 全选所有歌单（跨页，需多次请求）
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
                allIds = allIds.concat(items.map(p=>String(p.id)));
                items.forEach(p => {
                    fullPlaylistMap[String(p.id)] = p;
                });
            }
            showLoading(false);
            // 若已全选则反选，否则选中所有
            if (selectedPlaylistIds.length === allIds.length) {
                selectedPlaylistIds = [];
            } else {
                selectedPlaylistIds = [...allIds];
            }
            allPlaylistMap = fullPlaylistMap;
            displayPlaylists(playlistState.playlists);
        };
        // 全选本页歌单（仅当前页）
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
    // 单曲页面已无批量操作按钮
    container.classList.remove('hidden');
}

/**
 * 渲染单曲列表，每条包含封面、歌名、歌手、预览/下载按钮、复选框
 * @param {Array} songs - 单曲对象数组
 * @param {string} containerId - 渲染结果容器ID
 */
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
        // 兼容不同API的歌手字段
        const artists = song.ar ? song.ar.map(a => a.name).join(', ') : song.artists.map(a => a.name).join(', ');
        // 是否选中
        const checked = selectedSongsIds.includes(idStr) ? 'checked' : '';
        const songDiv = document.createElement('div');
        songDiv.className = 'flex items-center p-2 border-b hover:bg-gray-50 hover:shadow-md transition-all duration-200';
        songDiv.innerHTML = `
            <input type="checkbox" class="song-checkbox w-5 h-5 mr-2 appearance-none border-2 border-gray-400 rounded checked:bg-blue-500 checked:border-blue-500 transition-all duration-200"
                data-id="${idStr}" ${checked}>
            <img src="${song.al?.picUrl || 'https://p2.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg'}" alt="封面" class="w-12 h-12 rounded mr-2">
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
        // 缓存歌曲信息（批量下载用）
        allSongsMap[idStr] = { id: idStr, name: song.name + ' - ' + artists };
    });
    // 复选框事件：选中/取消时更新selectedSongsIds
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
 * 渲染歌单列表，每条包含封面、歌单名、歌曲数、复选框
 * @param {Array} playlists - 歌单对象数组
 */
function displayPlaylists(playlists) {
    renderBatchActionHeader();
    allPlaylistMap = {};
    const resultsDiv = document.getElementById('search-results');
    resultsDiv.innerHTML = '';
    if (playlists.length === 0) {
        resultsDiv.innerHTML = '<p>无结果</p>';
        return;
    }
    playlists.forEach(playlist => {
        allPlaylistMap[playlist.id] = playlist;
        const checked = selectedPlaylistIds.includes(String(playlist.id)) ? 'checked' : '';
        const playlistDiv = document.createElement('div');
        playlistDiv.className = 'flex items-center p-2 border-b hover:bg-gray-50 hover:shadow-md cursor-pointer transition-all duration-200';
        playlistDiv.dataset.id = playlist.id;
        playlistDiv.dataset.name = playlist.name;
        playlistDiv.dataset.trackCount = playlist.trackCount;
        playlistDiv.innerHTML = `
            <input type="checkbox" class="playlist-checkbox w-5 h-5 mr-2" data-id="${playlist.id}" ${checked}>
            <img src="${playlist.coverImgUrl || 'https://p2.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg'}" alt="封面" class="w-12 h-12 rounded mr-5">
            <span class="flex-1 playlist-title-span">${playlist.name} <span class="text-gray-500 text-sm">(${playlist.trackCount}首)</span></span>
        `;
        // 点击歌单区域可进入歌单详情页
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
    });
    // 歌单复选框事件：选中/取消时更新selectedPlaylistIds
    resultsDiv.querySelectorAll('.playlist-checkbox').forEach(cb => {
        cb.addEventListener('change', function() {
            const pid = String(this.dataset.id);
            if (this.checked) {
                if (!selectedPlaylistIds.includes(pid)) selectedPlaylistIds.push(pid);
            } else {
                selectedPlaylistIds = selectedPlaylistIds.filter(id => id !== pid);
            }
        });
    });
}

/**
 * 渲染分页导航区，支持大页码横向滚动
 */
function renderPagination() {
    const paginationDiv = document.getElementById('pagination');
    paginationDiv.innerHTML = '';
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    if (totalPages <= 15) {
        // 小页数直接渲染所有页码
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
        // 大页数横向滚动
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

/**
 * 页码切换时刷新视图
 */
function updatePagination() {
    if (currentMode === 'playlist') {
        searchMusic();
    } else if (currentMode === 'playlist-songs') {
        openPlaylist(playlistState.id, playlistState.name, playlistState.trackCount);
    } else {
        searchMusic();
    }
}

/**
 * 歌单详情页拉取当前页歌曲列表并渲染
 * @param {string|number} playlistId - 歌单ID
 * @param {string} playlistName - 歌单名
 * @param {number} trackCount - 歌单歌曲总数
 */
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

/**
 * 歌单详情页“全选”按钮，跨页全选所有歌曲
 */
async function selectAllHandler() {
    if (!playlistState?.id) return;
    if (!allSongIdsInPlaylist.length) {
        let detail = await fetchWithRetry(`${cloudApi}/playlist/detail?id=${playlistState.id}`);
        let total = detail?.playlist?.trackCount || 0;
        let perPage = 1000;
        let allIds = [];
        for (let i = 0; i < total; i += perPage) {
            let tracks = await fetchWithRetry(`${cloudApi}/playlist/track/all?id=${playlistState.id}&limit=${perPage}&offset=${i}`);
            allIds = allIds.concat(tracks.songs.map(s=>String(s.id)));
        }
        allSongIdsInPlaylist = allIds;
    }
    // 若已全选则反选，否则选中所有
    if (selectedSongsIds.length === allSongIdsInPlaylist.length) {
        selectedSongsIds = [];
    } else {
        selectedSongsIds = [...allSongIdsInPlaylist];
    }
    openPlaylist(playlistState.id, playlistState.name, playlistState.trackCount);
}

/**
 * 歌单详情页返回按钮，恢复到歌单列表页
 */
function backHandler() {
    currentMode = 'playlist';
    currentPage = playlistState.page || 1;
    searchKeywords = playlistState.keywords || searchKeywords;
    selectedSongsIds = [];
    allSongsMap = {};
    searchMusic();
    document.getElementById('playlist-details').classList.add('hidden');
}

/* ==============================
   4. 单曲操作区事件委托
   ============================== */

/**
 * 页面全局点击事件，处理预览、下载、复选框点选等
 */
document.addEventListener('click', async (e) => {
    const previewDiv = document.getElementById('preview');
    // 非预览区点击时关闭预览弹窗
    if (!e.target.closest('#preview') && !e.target.closest('.preview-btn') && !previewDiv.classList.contains('hidden')) {
        previewDiv.classList.add('hidden');
        previewDiv.innerHTML = '';
    }
    // 点击歌曲名区，切换勾选状态（复选框同步）
    if (e.target.closest('span.cursor-pointer')) {
        const checkbox = e.target.closest('span').parentElement.querySelector('.song-checkbox');
        checkbox.checked = !checkbox.checked;
        const songId = checkbox.dataset.id;
        if (checkbox.checked) {
            if (!selectedSongsIds.includes(songId)) selectedSongsIds.push(songId);
        } else {
            selectedSongsIds = selectedSongsIds.filter(id => id !== songId);
        }
    }
    // 预览按钮，弹窗播放音频
    if (e.target.closest('.preview-btn')) {
        const songId = e.target.closest('.preview-btn').dataset.id;
        const quality = document.getElementById('quality-select').value || 'standard';
        showLoading(true);
        try {
            const url = `${apiBase}?id=${songId}&level=${quality}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error('获取直链失败');
            let songUrl = await response.text();
            showLoading(false);
            if (!songUrl.startsWith('http')) {
                alert('无法预览该歌曲！API返回内容：' + songUrl);
                return;
            }
            previewDiv.classList.remove('hidden');
            previewDiv.style.position = 'fixed';
            previewDiv.style.bottom = '20px';
            previewDiv.style.right = '20px';
            previewDiv.style.width = '300px';
            previewDiv.style.zIndex = '1000';
            previewDiv.innerHTML = `
                <div class="bg-white p-4 rounded shadow-lg border">
                    <audio controls autoplay src="${songUrl}" class="w-full mt-2"></audio>
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
    // 下载按钮，单曲下载（自动识别音频格式）
    if (e.target.closest('.download-btn')) {
        const songId = e.target.closest('.download-btn').dataset.id;
        const fileName = e.target.closest('.download-btn').dataset.name;
        const quality = document.getElementById('quality-select').value || 'standard';
        isDownloading = true;
        showLoading(true);
        showProgress(true, 0, "正在获取直链...");
        try {
            const url = `${apiBase}?id=${songId}&level=${quality}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error('获取直链失败');
            let songUrl = await response.text();
            showProgress(true, 30, "正在下载音频...");
            if (!songUrl.startsWith('http')) {
                alert('无法下载该歌曲！API返回内容：' + songUrl);
                isDownloading = false;
                showLoading(false);
                showProgress(false);
                return;
            }
            const musicResponse = await fetch(songUrl);
            if (!musicResponse.ok) throw new Error('下载歌曲失败');
            let ext = 'mp3';
            try {
                ext = songUrl.split('?')[0].split('.').pop().toLowerCase();
                if (!/^mp3|flac|wav|ape$/.test(ext)) ext = 'mp3';
            } catch(e) { ext = 'mp3'; }
            let fakePercent = 30;
            const fakeUpdate = setInterval(() => {
                fakePercent += Math.random() * 10;
                if (fakePercent > 90) fakePercent = 90;
                showProgress(true, fakePercent, `下载进度：${Math.round(fakePercent)}%`);
            }, 200);
            const blob = await musicResponse.blob();
            clearInterval(fakeUpdate);
            showProgress(true, 100, "准备保存...");
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `${fileName}.${ext}`;
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

/* ==============================
   5. 批量下载及辅助函数
   ============================== */

/**
 * 获取当前时间字符串（用于zip包名）
 * @returns {string} - 格式化时间字符串
 */
function getNowTimeStr() {
    const now = new Date();
    const Y = now.getFullYear();
    const M = String(now.getMonth() + 1).padStart(2, '0');
    const D = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    return `${Y}年${M}月${D}日${h}-${m}`;
}

/**
 * 批量下载选中单曲，生成zip文件并触发保存
 */
document.getElementById('download-btn').addEventListener('click', async () => {
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
            const url = `${apiBase}?id=${song.id}&level=${quality}`;
            let songUrl = await fetch(url).then(r => r.text());
            if (!songUrl.startsWith('http')) continue;
            let ext = 'mp3';
            try {
                ext = songUrl.split('?')[0].split('.').pop().toLowerCase();
                if (!/^mp3|flac|wav|ape$/.test(ext)) ext = 'mp3';
            } catch(e) { ext = 'mp3'; }
            let musicBlob = await fetch(songUrl).then(r => r.blob());
            zip.file(`${song.name}.${ext}`, musicBlob);
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
});

/**
 * 批量下载整个歌单，返回zip二进制（用于其它扩展场景）
 * @param {string|number} pid - 歌单ID
 * @param {string} pname - 歌单名
 * @returns {Promise<Blob|null>} - 返回打包好的zip文件Blob
 */
async function batchDownloadPlaylistReturnZip(pid, pname) {
    showProgress(true, 0, `正在获取歌单: ${pname}`);
    let allSongs = [];
    try {
        let detail = await fetchWithRetry(`${cloudApi}/playlist/detail?id=${pid}`);
        let total = detail?.playlist?.trackCount || 0;
        let perPage = 1000;
        for (let i = 0; i < total; i += perPage) {
            let tracks = await fetchWithRetry(`${cloudApi}/playlist/track/all?id=${pid}&limit=${perPage}&offset=${i}`);
            allSongs = allSongs.concat(tracks.songs);
            showProgress(true, Math.round((i+perPage)/total*80), `歌单加载进度: ${Math.min(i+perPage,total)}/${total}`);
        }
        let ids = allSongs.map(s => s.id);
        let names = allSongs.map(s => s.name + ' - ' + (s.ar ? s.ar.map(a=>a.name).join(',') : ''));
        const quality = document.getElementById('quality-select').value || 'standard';
        const zip = new JSZip();
        for (let i = 0; i < ids.length; i++) {
            let url = `${apiBase}?id=${ids[i]}&level=${quality}`;
            let songUrl = await fetch(url).then(r=>r.text());
            if (!songUrl.startsWith('http')) continue;
            let ext = 'mp3';
            try {
                ext = songUrl.split('?')[0].split('.').pop().toLowerCase();
                if (!/^mp3|flac|wav|ape$/.test(ext)) ext = 'mp3';
            } catch(e) { ext = 'mp3'; }
            let musicBlob = await fetch(songUrl).then(r=>r.blob());
            zip.file(`${names[i]}.${ext}`, musicBlob);
            showProgress(true, 80 + Math.round((i+1)/ids.length*20), `下载进度: ${i+1}/${ids.length}`);
        }
        showProgress(true, 100, "正在打包...");
        let content = await zip.generateAsync({type:'blob'});
        return content;
    } catch (err) {
        showProgress(false);
        alert(`${pname} 歌单下载失败: ` + err.message);
        return null;
    }
}
