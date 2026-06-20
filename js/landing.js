/**
 * landing.js — Mobile-first landing layer
 *
 * Manages:
 *  - Drawer (☰ button → half-page slide-up with Connect / Browse / Edit tabs)
 *  - Model picker (pills: individual models + ALL, auto-failover)
 *  - Chat history strip (horizontal scroll above input)
 *  - Wires into existing app.js / chat / settings without replacing them
 */

import { State, EventBus, Storage } from './core.js';

// ============================================
// STATE
// ============================================

const LS = {
  drawerOpen: false,
  drawerTab: 'connect',       // connect | browse | edit
  historyCollapsed: false,
  activeModels: new Set(),    // model ids selected; empty = ALL
  useAll: true,
  currentModelIndex: 0,       // for failover round-robin
  models: [],                 // [{id, name, provider}]
};

// ============================================
// DRAWER
// ============================================

function openDrawer() {
  LS.drawerOpen = true;
  const overlay = document.getElementById('lsDrawerOverlay');
  if (overlay) overlay.classList.add('open');
}

function closeDrawer() {
  LS.drawerOpen = false;
  const overlay = document.getElementById('lsDrawerOverlay');
  if (overlay) overlay.classList.remove('open');
}

function switchDrawerTab(tab) {
  LS.drawerTab = tab;
  document.querySelectorAll('.ls-drawer-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.ls-drawer-panel').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.panel === tab);
  });
}

// ============================================
// MODEL PICKER
// ============================================

function renderModelPills() {
  const row = document.getElementById('lsModelRow');
  if (!row) return;
  row.innerHTML = '';

  // ALL pill
  const allPill = document.createElement('button');
  allPill.className = 'ls-model-pill all-pill' + (LS.useAll ? ' active' : '');
  allPill.dataset.model = '__all__';
  allPill.innerHTML = `<span class="pill-dot"></span> ALL`;
  allPill.addEventListener('click', () => toggleModel('__all__'));
  row.appendChild(allPill);

  // Individual model pills
  LS.models.forEach(m => {
    const pill = document.createElement('button');
    const isActive = LS.useAll || LS.activeModels.has(m.id);
    pill.className = 'ls-model-pill' + (isActive ? ' active' : '');
    pill.dataset.model = m.id;
    pill.innerHTML = `<span class="pill-dot"></span> ${m.name}`;
    pill.addEventListener('click', () => toggleModel(m.id));
    row.appendChild(pill);
  });
}

function toggleModel(id) {
  if (id === '__all__') {
    LS.useAll = true;
    LS.activeModels.clear();
  } else {
    LS.useAll = false;
    if (LS.activeModels.has(id)) {
      LS.activeModels.delete(id);
      if (LS.activeModels.size === 0) {
        // Deselected last one → revert to ALL
        LS.useAll = true;
      }
    } else {
      LS.activeModels.add(id);
    }
  }
  renderModelPills();
  saveModelPrefs();
  EventBus.emit('landing:models:changed', getActiveModelList());
}

function getActiveModelList() {
  if (LS.useAll) return LS.models.map(m => m.id);
  return [...LS.activeModels];
}

function saveModelPrefs() {
  Storage.set('landing.modelPrefs', {
    useAll: LS.useAll,
    active: [...LS.activeModels],
  });
}

function loadModelPrefs() {
  const saved = Storage.get('landing.modelPrefs');
  if (!saved) return;
  LS.useAll = saved.useAll !== false;
  LS.activeModels = new Set(saved.active || []);
}

// Populate models from whatever the LLM manager loaded
function syncModelsFromState() {
  const raw = State.models || [];
  // Build: Gemini variants, Groq variants, OpenRouter best free picks
  // plus everything else already loaded
  const priorityOrder = [
    // Gemini free models
    'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro',
    // Groq free models
    'llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'mixtral-8x7b-32768',
    // OpenRouter best free
    'google/gemini-2.0-flash-exp:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'mistralai/mistral-7b-instruct:free',
  ];

  // Sort: priority models first, rest after
  const sorted = [...raw].sort((a, b) => {
    const ai = priorityOrder.indexOf(a.id);
    const bi = priorityOrder.indexOf(b.id);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  LS.models = sorted.map(m => ({
    id: m.id,
    name: m.name || m.id,
    provider: m.owned_by || '',
  }));

  renderModelPills();
}

// ============================================
// FAILOVER — pick next model when one exhausts tokens
// ============================================

let _originalSendMessage = null;

function installFailover() {
  if (!window.Chat) return;
  if (_originalSendMessage) return; // already installed

  _originalSendMessage = window.Chat.sendMessage.bind(window.Chat);

  window.Chat.sendMessage = async function failoverSend(text, opts = {}) {
    const list = getActiveModelList();
    if (list.length <= 1 || LS.useAll === false && LS.activeModels.size <= 1) {
      return _originalSendMessage(text, opts);
    }

    // Try current model; on rate-limit / token error rotate to next
    const startIdx = LS.currentModelIndex % list.length;
    for (let attempt = 0; attempt < list.length; attempt++) {
      const idx = (startIdx + attempt) % list.length;
      const modelId = list[idx];

      // Set model in select
      const sel = document.getElementById('modelSelect');
      if (sel) {
        sel.value = modelId;
        sel.dispatchEvent(new Event('change'));
      }

      try {
        const result = await _originalSendMessage(text, opts);
        LS.currentModelIndex = idx; // stick with winner
        hideFailoverBar();
        return result;
      } catch (err) {
        const isLimit = err?.message?.toLowerCase().includes('rate') ||
          err?.message?.toLowerCase().includes('limit') ||
          err?.message?.toLowerCase().includes('quota') ||
          err?.status === 429;

        if (isLimit && attempt < list.length - 1) {
          showFailoverBar(modelId, list[(idx + 1) % list.length]);
          continue; // try next
        }
        throw err; // not a limit error, propagate
      }
    }
  };
}

function showFailoverBar(failedModel, nextModel) {
  const bar = document.getElementById('lsFailoverBar');
  if (!bar) return;
  const failName = LS.models.find(m => m.id === failedModel)?.name || failedModel;
  const nextName = LS.models.find(m => m.id === nextModel)?.name || nextModel;
  bar.innerHTML = `<span>${failName}</span> hit limit → switching to <span>${nextName}</span>`;
  bar.classList.add('visible');
}

function hideFailoverBar() {
  document.getElementById('lsFailoverBar')?.classList.remove('visible');
}

// ============================================
// CHAT HISTORY STRIP
// ============================================

function renderHistory() {
  const list = document.getElementById('lsHistoryList');
  if (!list) return;

  const convos = Storage.get('chat.conversations') || [];
  list.innerHTML = '';

  if (convos.length === 0) {
    list.innerHTML = '<span class="ls-history-empty">No past chats yet</span>';
    return;
  }

  // Show last 20 most recent
  [...convos].reverse().slice(0, 20).forEach(c => {
    const item = document.createElement('button');
    item.className = 'ls-history-item';
    item.title = c.title || 'Chat';
    item.textContent = c.title || 'Chat';
    item.addEventListener('click', () => {
      if (window.Chat?.loadConversation) {
        window.Chat.loadConversation(c.id);
        window.showToast?.(`Loaded: ${c.title || 'Chat'}`, 'success');
      }
    });
    list.appendChild(item);
  });
}

function toggleHistory() {
  LS.historyCollapsed = !LS.historyCollapsed;
  document.getElementById('lsHistorySection')?.classList.toggle('collapsed', LS.historyCollapsed);
}

// ============================================
// CONNECT PANEL — sync git connection status
// ============================================

function updateConnectStatus() {
  const gitStatus = document.getElementById('lsGitStatus');
  const llmStatus = document.getElementById('lsLlmStatus');
  if (!gitStatus || !llmStatus) return;

  // Git
  const hasGit = State.connections?.length > 0;
  gitStatus.textContent = hasGit ? 'Connected' : 'Not set';
  gitStatus.className = 'ls-connect-status' + (hasGit ? ' connected' : '');

  // LLM
  const hasLlm = !!(State.settings?.llmEndpoint && State.settings?.llmApiKey);
  llmStatus.textContent = hasLlm ? 'Connected' : 'Not set';
  llmStatus.className = 'ls-connect-status' + (hasLlm ? ' connected' : '');
}

// ============================================
// INJECT LANDING HTML
// ============================================

function injectLandingHTML() {
  // Insert topbar before chat-panel content
  const chatPanel = document.querySelector('.chat-panel');
  if (!chatPanel) return;

  // Top bar (menu + model pills + failover)
  const topbar = document.createElement('div');
  topbar.className = 'ls-topbar';
  topbar.innerHTML = `
    <button class="ls-menu-btn" id="lsMenuBtn" aria-label="Open menu">☰</button>
    <div class="ls-model-row" id="lsModelRow"></div>
  `;
  chatPanel.prepend(topbar);

  // Failover bar
  const failBar = document.createElement('div');
  failBar.className = 'ls-failover-bar';
  failBar.id = 'lsFailoverBar';
  chatPanel.insertBefore(failBar, chatPanel.children[1]);

  // History section (above input)
  const inputWrapper = chatPanel.querySelector('.chat-input-wrapper');
  if (inputWrapper) {
    const histSection = document.createElement('div');
    histSection.className = 'ls-history-section';
    histSection.id = 'lsHistorySection';
    histSection.innerHTML = `
      <div class="ls-history-header" id="lsHistoryHeader">
        <span>History</span>
        <span class="ls-history-chevron">▼</span>
      </div>
      <div class="ls-history-list" id="lsHistoryList"></div>
    `;
    chatPanel.insertBefore(histSection, inputWrapper);
  }

  // Drawer overlay + drawer
  const drawer = document.createElement('div');
  drawer.className = 'ls-drawer-overlay';
  drawer.id = 'lsDrawerOverlay';
  drawer.innerHTML = `
    <div class="ls-drawer" id="lsDrawer">
      <div class="ls-drawer-handle"></div>
      <div class="ls-drawer-tabs">
        <button class="ls-drawer-tab active" data-tab="connect">Connect</button>
        <button class="ls-drawer-tab" data-tab="browse">Browse</button>
        <button class="ls-drawer-tab" data-tab="edit">Edit</button>
      </div>
      <div class="ls-drawer-content">

        <!-- CONNECT -->
        <div class="ls-drawer-panel active" data-panel="connect">
          <div class="ls-connect-section">
            <h4>Git</h4>
            <button class="ls-connect-btn" id="lsOpenGitSettings">
              <span class="ls-btn-icon">⑂</span>
              GitHub / GitLab / Gitea
              <span class="ls-connect-status" id="lsGitStatus">Not set</span>
            </button>
          </div>
          <div class="ls-connect-section">
            <h4>AI Model</h4>
            <button class="ls-connect-btn" id="lsOpenLlmSettings">
              <span class="ls-btn-icon">⚡</span>
              LLM Provider &amp; API Key
              <span class="ls-connect-status" id="lsLlmStatus">Not set</span>
            </button>
          </div>
          <div class="ls-connect-section">
            <h4>Quick providers</h4>
            <button class="ls-connect-btn" id="lsSetGroq">
              <span class="ls-btn-icon">🟣</span>
              Groq (free, fast)
            </button>
            <button class="ls-connect-btn" id="lsSetGemini">
              <span class="ls-btn-icon">🔵</span>
              Google Gemini (free)
            </button>
            <button class="ls-connect-btn" id="lsSetOpenRouter">
              <span class="ls-btn-icon">🟡</span>
              OpenRouter (200+ models)
            </button>
          </div>
        </div>

        <!-- BROWSE -->
        <div class="ls-drawer-panel" data-panel="browse">
          <div class="ls-browse-actions">
            <button class="ls-browse-btn" id="lsBrowseFiles">
              <span class="ls-btn-icon">📁</span>
              <div>
                Browse Files
                <small>Open file tree for current repo</small>
              </div>
            </button>
            <button class="ls-browse-btn" id="lsBrowseUploadZip">
              <span class="ls-btn-icon">📦</span>
              <div>
                Upload Zip
                <small>Import a zip as a new branch</small>
              </div>
            </button>
            <button class="ls-browse-btn" id="lsBrowseSearch">
              <span class="ls-btn-icon">🔍</span>
              <div>
                Search Files
                <small>Search across the whole repo</small>
              </div>
            </button>
            <button class="ls-browse-btn" id="lsBrowseIssues">
              <span class="ls-btn-icon">🐛</span>
              <div>
                Issues &amp; PRs
                <small>View open issues and pull requests</small>
              </div>
            </button>
          </div>
        </div>

        <!-- EDIT -->
        <div class="ls-drawer-panel" data-panel="edit">
          <div class="ls-edit-launch">
            <p>Switch to full editor mode with file tree, code editor, and chat side by side.</p>
            <button class="ls-edit-launch-btn" id="lsLaunchEditor">
              Open Full Editor →
            </button>
            <p style="margin-top:12px">Or ask the AI to edit files directly in chat — just describe what you want changed.</p>
          </div>
        </div>

      </div>
    </div>
  `;
  document.body.appendChild(drawer);
}

// ============================================
// WIRE EVENTS
// ============================================

function wireEvents() {
  // Menu button
  document.getElementById('lsMenuBtn')?.addEventListener('click', openDrawer);

  // Close drawer on overlay click (outside drawer)
  document.getElementById('lsDrawerOverlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('lsDrawerOverlay')) closeDrawer();
  });

  // Drawer tabs
  document.querySelectorAll('.ls-drawer-tab').forEach(btn => {
    btn.addEventListener('click', () => switchDrawerTab(btn.dataset.tab));
  });

  // History toggle
  document.getElementById('lsHistoryHeader')?.addEventListener('click', toggleHistory);

  // Connect buttons
  document.getElementById('lsOpenGitSettings')?.addEventListener('click', () => {
    closeDrawer();
    window.openSettings?.();
    // Switch to connections tab after settings opens
    setTimeout(() => {
      document.querySelector('[data-tab="connections"]')?.click();
    }, 100);
  });

  document.getElementById('lsOpenLlmSettings')?.addEventListener('click', () => {
    closeDrawer();
    window.openSettings?.();
    setTimeout(() => {
      document.querySelector('[data-tab="llm"]')?.click();
    }, 100);
  });

  // Quick provider presets
  document.getElementById('lsSetGroq')?.addEventListener('click', () => {
    if (State.settings) {
      State.settings.llmProvider = 'groq';
      State.settings.llmEndpoint = 'https://api.groq.com/openai/v1';
    }
    closeDrawer();
    window.openSettings?.();
    setTimeout(() => document.querySelector('[data-tab="llm"]')?.click(), 100);
    window.showToast?.('Groq preset loaded — add your API key', 'info');
  });

  document.getElementById('lsSetGemini')?.addEventListener('click', () => {
    if (State.settings) {
      State.settings.llmProvider = 'gemini';
      State.settings.llmEndpoint = 'https://generativelanguage.googleapis.com/v1beta/openai';
    }
    closeDrawer();
    window.openSettings?.();
    setTimeout(() => document.querySelector('[data-tab="llm"]')?.click(), 100);
    window.showToast?.('Gemini preset loaded — add your API key', 'info');
  });

  document.getElementById('lsSetOpenRouter')?.addEventListener('click', () => {
    if (State.settings) {
      State.settings.llmProvider = 'openrouter';
      State.settings.llmEndpoint = 'https://openrouter.ai/api/v1';
    }
    closeDrawer();
    window.openSettings?.();
    setTimeout(() => document.querySelector('[data-tab="llm"]')?.click(), 100);
    window.showToast?.('OpenRouter preset loaded — add your API key', 'info');
  });

  // Browse buttons
  document.getElementById('lsBrowseFiles')?.addEventListener('click', () => {
    closeDrawer();
    document.querySelector('.mobile-tab[data-panel="sidebar"]')?.click();
  });

  document.getElementById('lsBrowseUploadZip')?.addEventListener('click', () => {
    closeDrawer();
    window.openZipUpload?.();
  });

  document.getElementById('lsBrowseSearch')?.addEventListener('click', () => {
    closeDrawer();
    const { openSearchPanel } = window;
    if (openSearchPanel) openSearchPanel();
  });

  document.getElementById('lsBrowseIssues')?.addEventListener('click', () => {
    closeDrawer();
    // Switch sidebar to issues view
    document.querySelector('[data-view="issues"]')?.click();
    document.querySelector('.mobile-tab[data-panel="sidebar"]')?.click();
  });

  // Launch full editor
  document.getElementById('lsLaunchEditor')?.addEventListener('click', () => {
    closeDrawer();
    document.body.classList.remove('landing-mode');
    Storage.set('landing.fullEditor', true);
    window.showToast?.('Full editor mode — swipe tabs to navigate', 'success');
  });

  // EventBus listeners
  EventBus.on('models:loaded', syncModelsFromState);
  EventBus.on('settings:saved', () => {
    updateConnectStatus();
    syncModelsFromState();
  });
  EventBus.on('chat:conversation:saved', renderHistory);
  EventBus.on('chat:cleared', renderHistory);
  EventBus.on('project:loaded', updateConnectStatus);
}

// ============================================
// INIT
// ============================================

export function initLanding() {
  // Check if user previously switched to full editor
  if (Storage.get('landing.fullEditor')) {
    return; // keep desktop layout
  }

  // Apply landing class (mobile only via CSS)
  document.body.classList.add('landing-mode');

  injectLandingHTML();
  wireEvents();
  loadModelPrefs();
  renderModelPills();
  renderHistory();
  updateConnectStatus();

  // Install failover after Chat is ready
  EventBus.on('chat:ready', installFailover);
  // Also try immediately
  setTimeout(installFailover, 1500);

  // Sync models if already loaded
  if (State.models?.length) syncModelsFromState();
}
