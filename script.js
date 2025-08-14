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
                throw new
