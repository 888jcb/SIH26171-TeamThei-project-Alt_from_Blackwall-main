/**
 * popup/popup.js
 * Controls the PRIVISION reference UI popup interface:
 * - Top artwork and gear settings button
 * - Protection Active status pill & toggle
 * - Accordion 01: Detection rules & detection model selection
 * - Accordion 02: Activation mode & allowed websites management
 * - Preserves all Chrome storage and background service worker message protocols.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // DOM References
  const btnOpenOptions = document.getElementById('btnOpenOptions');
  const statusPill = document.getElementById('statusPill');
  const statusPillText = document.getElementById('statusPillText');

  // Accordion 01: Detection Rules
  const accDetectionRules = document.getElementById('accDetectionRules');
  const btnAccDetection = document.getElementById('btnAccDetection');
  const ruleEmails = document.getElementById('ruleEmails');
  const rulePhones = document.getElementById('rulePhones');
  const ruleAddresses = document.getElementById('ruleAddresses');
  const ruleIps = document.getElementById('ruleIps');
  const ruleNames = document.getElementById('ruleNames');
  const modelRadios = document.querySelectorAll('input[name="popupModelChoice"]');

  // Accordion 02: Activation Mode
  const accActivationMode = document.getElementById('accActivationMode');
  const btnAccActivation = document.getElementById('btnAccActivation');
  const modeRadioAlways = document.getElementById('modeRadioAlways');
  const modeRadioScoped = document.getElementById('modeRadioScoped');
  const allowedSitesBox = document.getElementById('allowedSitesBox');
  const allowedListContainer = document.getElementById('allowedListContainer');
  const btnAddWebsite = document.getElementById('btnAddWebsite');
  const addSiteInputWrap = document.getElementById('addSiteInputWrap');
  const newSiteInput = document.getElementById('newSiteInput');
  const btnSaveSite = document.getElementById('btnSaveSite');

  let currentConfig = null;
  let currentTabInfo = null;

  // Accordion Toggles (Only one expanded at a time like reference)
  btnAccDetection.addEventListener('click', () => {
    const isExpanded = accDetectionRules.classList.contains('expanded');
    accDetectionRules.classList.toggle('expanded', !isExpanded);
    btnAccDetection.setAttribute('aria-expanded', !isExpanded);
    if (!isExpanded) {
      accActivationMode.classList.remove('expanded');
      btnAccActivation.setAttribute('aria-expanded', 'false');
    }
  });

  btnAccActivation.addEventListener('click', () => {
    const isExpanded = accActivationMode.classList.contains('expanded');
    accActivationMode.classList.toggle('expanded', !isExpanded);
    btnAccActivation.setAttribute('aria-expanded', !isExpanded);
    if (!isExpanded) {
      accDetectionRules.classList.remove('expanded');
      btnAccDetection.setAttribute('aria-expanded', 'false');
    }
  });

  // Open Options Page via Gear Icon
  btnOpenOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Fetch initial extension state
  async function refreshState() {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'GET_STATUS' });
      if (!resp || !resp.success) return;

      currentConfig = resp.config;
      currentTabInfo = resp.currentTab;

      // Protection Active status pill
      const isEnabled = !!currentConfig.isEnabled;
      statusPill.classList.toggle('active', isEnabled);
      statusPill.classList.toggle('inactive', !isEnabled);
      statusPillText.textContent = isEnabled ? 'PROTECTION ACTIVE' : 'PROTECTION PAUSED';

      // Mode Radios
      const mode = currentConfig.mode || 'always-on';
      if (mode === 'site-scoped') {
        modeRadioScoped.checked = true;
        modeRadioAlways.checked = false;
        allowedSitesBox.style.display = 'block';
      } else {
        modeRadioAlways.checked = true;
        modeRadioScoped.checked = false;
        allowedSitesBox.style.display = 'block'; // Always visible inside expanded accordion 2 per design
      }

      // Render Allowed Websites
      renderAllowedWebsites(currentConfig.allowlist || []);

      // Model Radios
      const modelSource = currentConfig.modelSource || 'builtin';
      modelRadios.forEach(radio => {
        radio.checked = (radio.value === 'builtin' && modelSource === 'builtin') ||
                        (radio.value === 'custom-hf' && modelSource !== 'builtin');
      });

      // Detection Rules Toggles
      const rules = currentConfig.detectionRules || {};
      ruleEmails.checked = rules.emails !== false;
      rulePhones.checked = rules.phones !== false;
      ruleAddresses.checked = rules.addresses !== false;
      ruleIps.checked = rules.ips !== false;
      ruleNames.checked = rules.names === true;

      // Check & update Reasoning Backend status
      try {
        const backendResp = await chrome.runtime.sendMessage({ action: 'CHECK_BACKEND' });
        const popupBackendPill = document.getElementById('popupBackendPill');
        const popupBackendDot = document.getElementById('popupBackendDot');
        const popupBackendText = document.getElementById('popupBackendText');
        if (popupBackendText && popupBackendPill && popupBackendDot) {
          if (backendResp && backendResp.isOnline) {
            popupBackendText.textContent = 'REASONING BACKEND: ONLINE';
            popupBackendDot.style.background = '#10B981';
            popupBackendPill.style.color = '#10B981';
            popupBackendPill.style.borderColor = 'rgba(16, 185, 129, 0.3)';
            popupBackendPill.style.background = 'rgba(16, 185, 129, 0.12)';
          } else {
            popupBackendText.textContent = 'REASONING BACKEND: OFFLINE';
            popupBackendDot.style.background = '#EF4444';
            popupBackendPill.style.color = '#EF4444';
            popupBackendPill.style.borderColor = 'rgba(239, 68, 68, 0.3)';
            popupBackendPill.style.background = 'rgba(239, 68, 68, 0.12)';
          }
        }
      } catch (backendErr) {
        console.warn('[PRIVISION Popup] Failed to query backend status:', backendErr);
      }

    } catch (err) {
      console.warn('[PRIVISION Popup] Failed to load state:', err);
    }
  }

  // Toggle master protection
  statusPill.addEventListener('click', async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'TOGGLE_ENABLED' });
      if (resp && resp.success) {
        await refreshState();
      }
    } catch (err) {
      console.error(err);
    }
  });

  // Switch Activation Mode
  modeRadioAlways.addEventListener('change', async () => {
    if (modeRadioAlways.checked) {
      await chrome.runtime.sendMessage({ action: 'SET_MODE', mode: 'always-on' });
      await refreshState();
    }
  });

  modeRadioScoped.addEventListener('change', async () => {
    if (modeRadioScoped.checked) {
      await chrome.runtime.sendMessage({ action: 'SET_MODE', mode: 'site-scoped' });
      await refreshState();
    }
  });

  // Switch Model Source
  modelRadios.forEach(radio => {
    radio.addEventListener('change', async () => {
      const newSource = radio.value;
      await chrome.storage.local.set({ modelSource: newSource });
      await refreshState();
    });
  });

  // Save detection rule toggles
  const updateRules = async () => {
    const detectionRules = {
      emails: ruleEmails.checked,
      phones: rulePhones.checked,
      addresses: ruleAddresses.checked,
      ips: ruleIps.checked,
      names: ruleNames.checked
    };
    await chrome.storage.local.set({ detectionRules });
  };

  [ruleEmails, rulePhones, ruleAddresses, ruleIps, ruleNames].forEach(toggle => {
    toggle.addEventListener('change', updateRules);
  });

  // Render Allowed Websites List
  function renderAllowedWebsites(list) {
    allowedListContainer.innerHTML = '';
    const defaultSites = ['chatgpt.com', 'claude.ai', 'gemini.google.com'];
    const displayList = list.length > 0 ? list : defaultSites;

    displayList.forEach(domain => {
      const item = document.createElement('div');
      item.className = 'allowed-item';
      item.innerHTML = `
        <span>${domain}</span>
        <button type="button" class="remove-site-btn" data-domain="${domain}" title="Remove website">&times;</button>
      `;
      allowedListContainer.appendChild(item);
    });

    allowedListContainer.querySelectorAll('.remove-site-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const domain = e.target.getAttribute('data-domain');
        await chrome.runtime.sendMessage({ action: 'REMOVE_ALLOWLIST_DOMAIN', domain });
        await refreshState();
      });
    });
  }

  // Add website UI toggle
  btnAddWebsite.addEventListener('click', () => {
    addSiteInputWrap.classList.toggle('hidden');
    if (!addSiteInputWrap.classList.contains('hidden')) {
      newSiteInput.focus();
    }
  });

  // Save new website
  btnSaveSite.addEventListener('click', async () => {
    const domain = newSiteInput.value.trim().toLowerCase();
    if (!domain) return;
    try {
      const hostname = domain.includes('://') ? new URL(domain).hostname : domain;
      if (hostname) {
        await chrome.runtime.sendMessage({ action: 'ADD_ALLOWLIST_DOMAIN', domain: hostname });
        newSiteInput.value = '';
        addSiteInputWrap.classList.add('hidden');
        await refreshState();
      }
    } catch (e) {
      console.error(e);
    }
  });

  newSiteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      btnSaveSite.click();
    }
  });

  // Initialize
  await refreshState();
});
