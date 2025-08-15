const itemsPerPage = 20;
let currentPage = 1;
let totalItems = 0;
let searchType = '1';
let searchKeywords = '';
let selectedSongs = [];
let playlistState = null;
let currentMode = 'initial';
let isDownloading = false;

let selectedSongsIds = [];
let allSongsMap = {}; // id -> song对象
let selectedPlaylistIds = [];
let allPlaylistMap = {}; // id -> 歌单对象
let allSongIdsInPlaylist = []; // 歌单详情页所有歌曲ID

const apiBase = 'https://api.lxchen.cn/api';
const cloudApi = 'https://163api.qijieya.cn';

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

function showElements(show) {
    document.getElementById('options').classList.toggle('hidden', !show);
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
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
            throw error;
        }
    }
}

// --- 批量操作按钮渲染 ---
function renderBatchActionHeader() {
    const container = document.getElementById('batch-action-header');
    container.innerHTML = '';
    if (currentMode === 'playlist') {
        container.innerHTML = `
            <button id="select-all-playlist-btn" class="p-2 bg-blue-500 hover-effect rounded text-white">全选所有歌单</button>
            <button id="select-page-playlist-btn" class="p-2 bg-indigo-500 hover-effect rounded text-white">全选本页歌单</button>
            <button id="download-selected-playlists-btn" class="p-2 bg-green-500 hover-effect rounded text-white">下载选中歌单</button>
        `;
        // 全选所有歌单（跨页）
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
            if (selectedPlaylistIds.length === allIds.length) {
                selectedPlaylistIds = [];
            } else {
                selectedPlaylistIds = [...allIds];
            }
            allPlaylistMap = fullPlaylistMap;
            displayPlaylists(playlistState.playlists);
        };
        // 全选本页歌单
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
        document.getElementById('download-selected-playlists-btn').onclick = async () => {
            if (selectedPlaylistIds.length === 0) {
                alert('请先选择歌单！');
                return;
            }
            if (!confirm(`将下载${selectedPlaylistIds.length}个歌单，每个歌单单独zip，最后打包zip。确定继续？`)) return;

            showProgress(true, 1, "准备下载所有歌单...");
            let mainZip = new JSZip();
            for (let idx = 0; idx < selectedPlaylistIds.length; idx++) {
                const pid = selectedPlaylistIds[idx];
                const pname = allPlaylistMap[pid]?.name || `歌单_${pid}`;
                showProgress(true, Math.round((idx/selectedPlaylistIds.length)*100), `下载歌单(${idx+1}/${selectedPlaylistIds.length}): ${pname}`);
                const zipBlob = await batchDownloadPlaylistReturnZip(pid, pname);
                if (zipBlob) {
                    mainZip.file(`${pname}.zip`, zipBlob);
                }
            }
            showProgress(true, 100, "正在最终打包所有歌单...");
            const mainZipBlob = await mainZip.generateAsync({type:'blob'});
            const link = document.createElement('a');
            link.href = URL.createObjectURL(mainZipBlob);
            link.download = `批量歌单下载_${getNowTimeStr()}.zip`;
            link.click();
            showProgress(false);
        };
    }
    if (currentMode === 'search') {
        container.innerHTML = `
            <button id="select-all-song-btn" class="p-2 bg-blue-500 hover-effect rounded text-white">全选本页单曲</button>
        `;
        document.getElementById('select-all-song-btn').onclick = () => {
            // 全选本页单曲
            const resultsDiv = document.getElementById('search-results');
            const songCheckboxes = Array.from(resultsDiv.querySelectorAll('.song-checkbox'));
            const pageIds = songCheckboxes.map(cb => cb.dataset.id);
            const allPageSelected = pageIds.every(id => selectedSongsIds.includes(id));
            if (allPageSelected) {
                selectedSongsIds = selectedSongsIds.filter(id => !pageIds.includes(id));
            } else {
                pageIds.forEach(id => {
                    if (!selectedSongsIds.includes(id)) selectedSongsIds.push(id);
                });
            }
            searchMusic();
        };
    }
    container.classList.remove('hidden');
}

// 其余代码保持不变
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
        allSongsMap[idStr] = { id: idStr, name: song.name + ' - ' + artists };
    });
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

// 其余分页、歌单详情、下载等逻辑保持不变
// ...（分页、单曲/歌单详情页、下载相关函数，与之前版本一致）...
