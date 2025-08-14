const itemsPerPage = 20;
let currentPage = 1;
let totalItems = 0;
let searchType = '1';
let searchKeywords = '';
let selectedSongs = [];
let playlistState = null;
let currentMode = 'initial';
let isDownloading = false;

// 新API，获取音乐直链（已修改为你的宝塔 Node.js API地址！）
const apiBase = 'https://api.lxchen.cn/api';
// 原网易云API，仅用于搜索/歌单数据
const cloudApi = 'https://163api.qijieya.cn';

document.getElementById('search-btn').addEventListener('click', async () => {
    searchType = document.getElementById('search-type').value;
    searchKeywords = document.getElementById('search-input').value.trim();
    if (!searchKeywords) {
        alert('请输入搜索关键词！');
        return;
    }
    currentPage = 1;

    if (searchType === '1000' && /^\d{5,}$/.test(searchKeywords)) {
        currentMode = 'playlist-songs';
        await tryOpenPlaylistById(searchKeywords);
    } else {
        currentMode = searchType === '1' ? 'search' : 'playlist';
        showElements(true);
        searchMusic();
    }
});

function showElements(show) {
    document.getElementById('options').classList.toggle('hidden', !show);
    document.getElementById('search-results').classList.toggle('hidden', !show);
    document.getElementById('pagination').classList.toggle('hidden', !show);
    document.getElementById('footer').classList.toggle('hidden', !show);
    document.getElementById('playlist-details').classList.toggle('hidden', !(show && currentMode === 'playlist-songs'));
}

function showLoading(show) {
    if (show) {
        document.getElementById('loading').classList.remove('hidden');
    } else if (!isDownloading) {
        document.getElementById('loading').classList.add('hidden');
    }
}

// 原API用于搜索和歌单详情
async function fetchWithRetry(url, options = {}, retries = 1, timeout = 15000) {
    for (let i = 0; i <= retries; i++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);
            if (!response.ok) {
                throw new Error(`HTTP 错误: ${response.status}`);
            }
            const data = await response.json();
            if (data.code !== 200) {
                throw new Error(`API 错误: ${data.message || '响应代码非200'}`);
            }
            return data;
        } catch (error) {
            clearTimeout(timeoutId);
            if (i < retries && error.name !== 'AbortError') {
                console.warn(`请求失败，重试 ${i + 1}/${retries}:`, error);
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
            throw error;
        }
    }
}

async function searchMusic() {
    showLoading(true);
    const offset = (currentPage - 1) * itemsPerPage;
    try {
        const data = await fetchWithRetry(
            `${cloudApi}/cloudsearch?keywords=${encodeURIComponent(searchKeywords)}&type=${searchType}&limit=${itemsPerPage}&offset=${offset}`
        );
        showLoading(false);
        if (searchType === '1') {
            displaySongs(data.result.songs || [], 'search-results');
            totalItems = data.result.songCount || 0;
        } else {
            playlistState = { playlists: data.result.playlists || [], page: currentPage, keywords: searchKeywords };
            displayPlaylists(data.result.playlists || []);
            totalItems = data.result.playlistCount || 0;
        }
        renderPagination();
    } catch (error) {
        showLoading(false);
        console.error('搜索失败:', error);
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
        console.error('获取歌单失败:', error);
        alert(error.name === 'AbortError' ? '请求超时，请稍后再试！' : '请求错误，请稍后再试');
        currentMode = 'playlist';
        searchMusic();
    }
}

function displaySongs(songs, containerId) {
    const resultsDiv = document.getElementById(containerId);
    resultsDiv.innerHTML = '';
    if (songs.length === 0) {
        resultsDiv.innerHTML = '<p>无结果</p>';
        return;
    }
    songs.forEach(song => {
        const artists = song.ar ? song.ar.map(a => a.name).join(', ') : song.artists.map(a => a.name).join(', ');
        const songDiv = document.createElement('div');
        songDiv.className = 'flex items-center p-2 border-b hover:bg-gray-50 hover:shadow-md transition-all duration-200';
        songDiv.innerHTML = `
            <img src="${song.al?.picUrl || 'https://p2.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg'}" alt="封面" class="w-12 h-12 rounded mr-2">
            <input type="checkbox" class="song-checkbox w-5 h-5 mr-2 appearance-none border-2 border-gray-400 rounded checked:bg-blue-500 checked:border-blue-500 transition-all duration-200" data-id="${song.id}">
            <span class="flex-1 cursor-pointer" data-id="${song.id}">
                ${song.name} <span class="text-gray-500 text-sm"> - ${artists}</span>
            </span>
            <button class="download-btn bg-green-500 text-white px-2 py-1 rounded hover:bg-green-600 hover:scale-105 transition-transform mr-2" data-id="${song.id}" data-name="${song.name} - ${artists}">
                <svg class="w-4 h-4 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>
                </svg>
            </button>
            <button class="preview-btn bg-blue-500 text-white px-2 py-1 rounded hover:bg-blue-600 hover:scale-105 transition-transform" data-id="${song.id}">
                <svg class="w-4 h-4 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.2A1 1 0 0010 9.768v4.464a1 1 0 001.555.832l3.197-2.2a1 1 0 000-1.664z"></path>
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
            </button>
        `;
        resultsDiv.appendChild(songDiv);
    });
}

function displayPlaylists(playlists) {
    const resultsDiv = document.getElementById('search-results');
    resultsDiv.innerHTML = '';
    if (playlists.length === 0) {
        resultsDiv.innerHTML = '<p>无结果</p>';
        return;
    }
    playlists.forEach(playlist => {
        const playlistDiv = document.createElement('div');
        playlistDiv.className = 'flex items-center p-2 border-b hover:bg-gray-50 hover:shadow-md cursor-pointer transition-all duration-200';
        playlistDiv.dataset.id = playlist.id;
        playlistDiv.dataset.name = playlist.name;
        playlistDiv.dataset.trackCount = playlist.trackCount;
        playlistDiv.innerHTML = `
            <img src="${playlist.coverImgUrl || 'https://p2.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg'}" alt="封面" class="w-12 h-12 rounded mr-5">
            <span class="flex-1">${playlist.name} <span class="text-gray-500 text-sm">(${playlist.trackCount}首)</span></span>
        `;
        playlistDiv.addEventListener('dblclick', () => {
            currentMode = 'playlist-songs';
            playlistState = { ...playlistState, id: playlist.id, name: playlist.name, trackCount: playlist.trackCount };
            currentPage = 1;
            openPlaylist(playlist.id, playlist.name, playlist.trackCount);
        });
        resultsDiv.appendChild(playlistDiv);
    });
}

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
        displaySongs(data.songs, 'search-results');
        totalItems = trackCount || data.songs.length;
        renderPagination();
        showElements(true);
    } catch (error) {
        showLoading(false);
        console.error('获取歌单失败:', error);
        alert(error.name === 'AbortError' ? '加载歌单超时，请稍后重试！' : '获取歌单失败，请检查网络！');
    }
}

function selectAllHandler() {
    const checkboxes = document.querySelectorAll('.song-checkbox');
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    checkboxes.forEach(cb => cb.checked = !allChecked);
}

function backHandler() {
    currentMode = 'playlist';
    currentPage = playlistState.page || 1;
    searchKeywords = playlistState.keywords || searchKeywords;
    searchMusic();
    document.getElementById('playlist-details').classList.add('hidden');
}

document.addEventListener('click', async (e) => {
    const previewDiv = document.getElementById('preview');
    if (!e.target.closest('#preview') && !e.target.closest('.preview-btn') && !previewDiv.classList.contains('hidden')) {
        previewDiv.classList.add('hidden');
        previewDiv.innerHTML = '';
    }
    if (e.target.closest('span.cursor-pointer')) {
        const checkbox = e.target.closest('span').parentElement.querySelector('.song-checkbox');
        checkbox.checked = !checkbox.checked;
    }
    // 预览功能（用你的宝塔 Node.js代理直链！）
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
            console.error('预览失败:', error);
            alert('预览失败，请检查网络！');
            previewDiv.classList.add('hidden');
        }
    }
    // 单曲下载（用你的宝塔 Node.js代理直链！）
    if (e.target.closest('.download-btn')) {
        const songId = e.target.closest('.download-btn').dataset.id;
        const fileName = e.target.closest('.download-btn').dataset.name;
        const quality = document.getElementById('quality-select').value || 'standard';
        isDownloading = true;
        showLoading(true);
        try {
            const url = `${apiBase}?id=${songId}&level=${quality}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error('获取直链失败');
            let songUrl = await response.text();
            if (!songUrl.startsWith('http')) {
                alert('无法下载该歌曲！API返回内容：' + songUrl);
                isDownloading = false;
                showLoading(false);
                return;
            }
            const musicResponse = await fetch(songUrl);
            if (!musicResponse.ok) throw new Error('下载歌曲失败');
            const blob = await musicResponse.blob();
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `${fileName}.mp3`;
            link.click();
            isDownloading = false;
            showLoading(false);
        } catch (error) {
            isDownloading = false;
            showLoading(false);
            console.error('单曲下载失败:', error);
            alert('下载失败，请检查网络！');
        }
    }
});

// 批量下载（用你的宝塔 Node.js代理直链！）
document.getElementById('download-btn').addEventListener('click', async () => {
    const checkboxes = document.querySelectorAll('.song-checkbox:checked');
    selectedSongs = Array.from(checkboxes).map(cb => ({
        id: cb.dataset.id,
        name: cb.parentElement.querySelector('.download-btn').dataset.name
    }));
    if (selectedSongs.length === 0) {
        alert('请先选择歌曲！');
        return;
    }
    const quality = document.getElementById('quality-select').value || 'standard';
    isDownloading = true;
    showLoading(true);
    try {
        const zip = new JSZip();
        for (const song of selectedSongs) {
            const url = `${apiBase}?id=${song.id}&level=${quality}`;
            let songUrl = await fetch(url).then(r => r.text());
            if (!songUrl.startsWith('http')) continue;
            let musicBlob = await fetch(songUrl).then(r => r.blob());
            zip.file(`${song.name}.mp3`, musicBlob);
        }
        const content = await zip.generateAsync({ type: 'blob' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(content);
        link.download = '音乐下载.zip';
        link.click();
        isDownloading = false;
        showLoading(false);
    } catch (error) {
        isDownloading = false;
        showLoading(false);
        console.error('批量下载失败:', error);
        alert('批量下载失败，请检查网络！');
    }
});
