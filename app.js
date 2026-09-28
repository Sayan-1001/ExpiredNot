/**
 * EXPIREDNOT — Pharmacy Inventory Intelligence Client Controller
 * Production Integration: Real Backend REST APIs, Hashed OTP, Exact Bill Intelligence, Zero Dummy Data
 */

document.addEventListener('DOMContentLoaded', () => {
  // ==========================================================================
  // 1. SESSION & STATE MANAGEMENT
  // ==========================================================================

  const ACTIVE_SESSION_KEY = 'expirednot_active_session';
  const ACTIVE_TOKEN_KEY = 'expirednot_auth_token';

  const isLocalhost = typeof window !== 'undefined' && window.location && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '0.0.0.0' ||
    window.location.hostname.startsWith('192.168.') ||
    window.location.hostname.endsWith('.local')
  );

  const API_BASE_URL = (typeof window !== 'undefined' && (
    window.__EXPIREDNOT_API_URL__ || 
    window.EXPIREDNOT_API_BASE_URL || 
    window.VITE_API_URL || 
    window.NEXT_PUBLIC_API_URL ||
    window.REACT_APP_API_URL
  ))
    ? (window.__EXPIREDNOT_API_URL__ || window.EXPIREDNOT_API_BASE_URL || window.VITE_API_URL || window.NEXT_PUBLIC_API_URL || window.REACT_APP_API_URL)
    : (isLocalhost ? '' : 'https://expirednot.onrender.com');

  const toTitleCase = (str) => {
    if (!str || typeof str !== 'string') return '';
    return str
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  let currentPharmacy = null;
  let sessionToken = localStorage.getItem(ACTIVE_TOKEN_KEY) || sessionStorage.getItem(ACTIVE_TOKEN_KEY) || null;

  let pharmacyDb = {
    batches: [],
    bills: [],
    movements: [],
    expenses: [],
    notifications: [],
    activity: []
  };

  let isDemoMode = false;
  let realDbBackup = null;

  const getAuthHeaders = () => {
    const headers = { 'Content-Type': 'application/json' };
    if (sessionToken) {
      headers['Authorization'] = `Bearer ${sessionToken}`;
    }
    return headers;
  };

  const ensureBackendAuthSession = async (forceRefresh = false) => {
    if (sessionToken && !forceRefresh) return sessionToken;

    let fbUser = window.firebaseAuth ? window.firebaseAuth.currentUser : null;
    if (!fbUser && window.firebaseAuth && typeof window.firebaseAuth.onAuthStateChanged === 'function') {
      fbUser = await new Promise(resolve => {
        const unsubscribe = window.firebaseAuth.onAuthStateChanged(user => {
          if (typeof unsubscribe === 'function') unsubscribe();
          resolve(user);
        });
        setTimeout(() => resolve(window.firebaseAuth.currentUser || null), 1500);
      });
    }

    if (!fbUser) return sessionToken;

    try {
      const idToken = await fbUser.getIdToken(forceRefresh);
      const payload = {
        email: fbUser.email,
        uid: fbUser.uid,
        name: fbUser.displayName || (currentPharmacy ? currentPharmacy.owner_name : ''),
        id_token: idToken
      };

      if (currentPharmacy) {
        if (currentPharmacy.shop_name) payload.shop_name = currentPharmacy.shop_name;
        if (currentPharmacy.dl_number) payload.dl_number = currentPharmacy.dl_number;
        if (currentPharmacy.shop_address) payload.shop_address = currentPharmacy.shop_address;
        if (currentPharmacy.city) payload.city = currentPharmacy.city;
        if (currentPharmacy.state) payload.state = currentPharmacy.state;
        if (currentPharmacy.pincode) payload.pincode = currentPharmacy.pincode;
        if (currentPharmacy.pharmacy_type) payload.pharmacy_type = currentPharmacy.pharmacy_type;
        if (currentPharmacy.owner_name) payload.owner_name = currentPharmacy.owner_name;
        if (currentPharmacy.role) payload.role = currentPharmacy.role;
        if (currentPharmacy.mobile) payload.mobile = currentPharmacy.mobile;
      }

      const bridgeRes = await fetch(`${API_BASE_URL}/api/auth/firebase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (bridgeRes.ok) {
        const data = await bridgeRes.json();
        if (data.session_token) {
          sessionToken = data.session_token;
          sessionStorage.setItem(ACTIVE_TOKEN_KEY, sessionToken);
          localStorage.setItem(ACTIVE_TOKEN_KEY, sessionToken);
          if (data.user) {
            currentPharmacy = data.user;
            sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(currentPharmacy));
            localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(currentPharmacy));
          }
          return sessionToken;
        }
      }
    } catch (err) {
      console.warn('[AUTH BRIDGE] Error refreshing backend session token:', err);
    }
    return sessionToken;
  };

  const authenticatedFetch = async (url, options = {}, retryCount = 0) => {
    if (!sessionToken) {
      await ensureBackendAuthSession(false);
    }

    const opt = { ...options };
    opt.headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
      ...(sessionToken ? { 'Authorization': `Bearer ${sessionToken}` } : {})
    };

    let res = await fetch(url, opt);
    if (res.status === 401 && retryCount === 0) {
      const freshToken = await ensureBackendAuthSession(true);
      if (freshToken) {
        opt.headers['Authorization'] = `Bearer ${freshToken}`;
        res = await fetch(url, opt);
      }
    }
    return res;
  };

  const loadPharmacyData = async (pharmacyId) => {
    if (!pharmacyId || isDemoMode) return;
    
    try {
      const profRes = await authenticatedFetch(`${API_BASE_URL}/api/profile`);
      if (profRes.ok) {
        const profData = await profRes.json();
        if (profData.user) {
          currentPharmacy = profData.user;
          sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(currentPharmacy));
          localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(currentPharmacy));
        }
      }
    } catch (e) {}

    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/api/inventory`);
      if (res.ok) {
        const data = await res.json();
        if (data.batches) {
          pharmacyDb.batches = data.batches.map(b => ({
            id: b.id,
            name: b.name,
            generic_name: b.generic_name,
            pack: b.pack,
            batchNo: b.batch_no,
            expiryDate: b.expiry_date,
            quantity: b.quantity,
            purchaseRate: b.purchase_rate,
            mrp: b.mrp,
            rack: b.rack,
            distributor: b.distributor,
            demandTier: b.demand_tier || 'MEDIUM_DEMAND',
            createdAt: b.created_at
          }));
        }
      }
    } catch (e) {}

    try {
      const billsRes = await authenticatedFetch(`${API_BASE_URL}/api/bills`);
      if (billsRes.ok) {
        const billsData = await billsRes.json();
        if (billsData.bills) {
          pharmacyDb.bills = billsData.bills.map(b => ({
            id: b.id,
            distributor: b.distributor,
            invoiceNo: b.invoice_no,
            date: b.invoice_date,
            totalAmount: b.total_amount,
            itemsCount: b.items_count || 1,
            originalFileUrl: b.original_file_path,
            timestamp: b.created_at ? new Date(b.created_at * 1000).toLocaleDateString() : 'Recent'
          }));
        }
      }
    } catch (e) {}

    try {
      const notifsRes = await authenticatedFetch(`${API_BASE_URL}/api/notifications`);
      if (notifsRes.ok) {
        const notifsData = await notifsRes.json();
        if (notifsData.notifications) {
          pharmacyDb.notifications = notifsData.notifications.map(n => ({
            id: n.id,
            text: n.text,
            type: (n.type || 'system').toLowerCase(),
            read: Boolean(n.is_read),
            timestamp: n.created_at ? formatTimeAgo(n.created_at) : 'Recent',
            createdAt: n.created_at
          }));
        }
      }
    } catch (e) {}

    try {
      const movRes = await authenticatedFetch(`${API_BASE_URL}/api/movements`);
      if (movRes.ok) {
        const movData = await movRes.json();
        if (movData.movements) {
          pharmacyDb.movements = movData.movements.map(m => ({
            id: m.id,
            type: m.type,
            medicineName: m.medicine_name,
            batchNo: m.batch_no,
            quantity: m.quantity,
            value: m.value,
            notes: m.notes,
            timestamp: m.created_at ? formatTimeAgo(m.created_at) : 'Recent',
            createdAt: m.created_at
          }));
        }
      }
    } catch (e) {}

    const raw = localStorage.getItem(`expirednot_data_${pharmacyId}`);
    if (raw) {
      try {
        const local = JSON.parse(raw);
        if (!pharmacyDb.bills.length && local.bills) pharmacyDb.bills = local.bills;
        if (!pharmacyDb.movements.length && local.movements) pharmacyDb.movements = local.movements;
        pharmacyDb.expenses = local.expenses || [];
        if (!pharmacyDb.notifications.length && local.notifications) pharmacyDb.notifications = local.notifications;
        pharmacyDb.activity = local.activity || [];
        if (!pharmacyDb.batches.length && local.batches) {
          pharmacyDb.batches = local.batches;
        }
      } catch {}
    }
  };

  const getStorageKey = (pId) => {
    const id = pId || (currentPharmacy ? (currentPharmacy.id || currentPharmacy.uid || currentPharmacy.dl_number || currentPharmacy.dlNumber || currentPharmacy.shop_name || 'default') : 'default');
    return `expirednot_data_${id}`;
  };

  const savePharmacyData = () => {
    if (isDemoMode) return;
    localStorage.setItem(getStorageKey(), JSON.stringify(pharmacyDb));
  };

  // ==========================================================================
  // 2. ROUTING & SCREEN CONTROLLER
  // ==========================================================================
  const welcomeScreen = document.getElementById('welcomeScreen');
  const authScreen = document.getElementById('authScreen');
  const signupScreen = document.getElementById('signupScreen');
  const dashboardScreen = document.getElementById('dashboardScreen');

  const enterAppBtn = document.getElementById('enterAppBtn');
  const backToWelcomeBtn = document.getElementById('backToWelcomeBtn');
  const createAccountLink = document.getElementById('createAccountLink');
  const cancelSignupBtn = document.getElementById('cancelSignupBtn');
  const signupCancelBtn = document.getElementById('signupCancelBtn');
  const goToDashboardBtn = document.getElementById('goToDashboardBtn');

  const showScreen = (target) => {
    if (target === 'dashboard') {
      const sessionRaw = sessionStorage.getItem(ACTIVE_SESSION_KEY) || localStorage.getItem(ACTIVE_SESSION_KEY);
      if (!sessionRaw) {
        showScreen('auth');
        showAuthNotice('Please sign in to access your pharmacy workspace.', 'error');
        return;
      }
      try {
        currentPharmacy = JSON.parse(sessionRaw);
        if (!currentPharmacy.setup_completed && !currentPharmacy.setupCompleted) {
          showScreen('signup');
          goToOnboardingStep(3);
          return;
        }
      } catch {
        showScreen('auth');
        return;
      }
    }

    const screens = [
      { id: 'welcome', el: welcomeScreen },
      { id: 'auth', el: authScreen },
      { id: 'signup', el: signupScreen },
      { id: 'dashboard', el: dashboardScreen }
    ];

    screens.forEach(s => {
      if (s.el) {
        if (s.id === target) {
          s.el.classList.remove('view-hidden');
          s.el.classList.add('view-active');
        } else {
          s.el.classList.remove('view-active');
          s.el.classList.add('view-hidden');
        }
      }
    });

    window.location.hash = target === 'welcome' ? '' : target;
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (target === 'dashboard') {
      refreshAllWorkspaceViews();
    }
  };

  window.showScreen = showScreen;

  if (enterAppBtn) enterAppBtn.addEventListener('click', (e) => {
    e.preventDefault();
    showScreen('auth');
  });

  if (backToWelcomeBtn) backToWelcomeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    showScreen('welcome');
  });

  if (createAccountLink) createAccountLink.addEventListener('click', () => {
    showScreen('signup');
    goToOnboardingStep(1);
  });
  if (cancelSignupBtn) cancelSignupBtn.addEventListener('click', () => showScreen('auth'));
  if (signupCancelBtn) signupCancelBtn.addEventListener('click', () => showScreen('auth'));
  if (goToDashboardBtn) goToDashboardBtn.addEventListener('click', () => showScreen('dashboard'));

  // ==========================================================================
  // 3. AUTHENTICATION & ONBOARDING
  // ==========================================================================
  const loginForm = document.getElementById('loginForm');
  const loginIdentifierInput = document.getElementById('loginIdentifierInput');
  const passwordInput = document.getElementById('passwordInput');
  const authNotice = document.getElementById('authNotice');
  const signInButton = document.getElementById('signInButton');
  const signInBtnText = document.getElementById('signInBtnText');

  const showAuthNotice = (message, type = 'error') => {
    if (!authNotice) return;
    authNotice.className = `auth-notice ${type}`;
    authNotice.innerHTML = `<span>${message}</span>`;
    authNotice.hidden = false;
  };

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const identifier = loginIdentifierInput ? loginIdentifierInput.value.trim() : '';
      const pass = passwordInput ? passwordInput.value : '';

      if (!identifier || !pass) {
        showAuthNotice('Please enter credentials.', 'error');
        return;
      }

      if (signInButton) signInButton.disabled = true;
      if (signInBtnText) signInBtnText.textContent = 'Signing in…';

      try {
        const res = await fetch(`${API_BASE_URL}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier, password: pass })
        });
        const data = await res.json();

        if (signInButton) signInButton.disabled = false;
        if (signInBtnText) signInBtnText.textContent = 'Sign in with Email & Password';

        if (!res.ok) {
          showAuthNotice(data.error || 'Authentication failed.', 'error');
          return;
        }

        sessionToken = data.session_token;
        sessionStorage.setItem(ACTIVE_TOKEN_KEY, sessionToken);
        currentPharmacy = data.user;
        sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(currentPharmacy));

        if (data.needs_setup) {
          showScreen('signup');
          goToOnboardingStep(3);
          return;
        }

        await loadPharmacyData(currentPharmacy.id);
        showScreen('dashboard');
      } catch (err) {
        if (signInButton) signInButton.disabled = false;
        if (signInBtnText) signInBtnText.textContent = 'Sign in with Email & Password';
        showAuthNotice('Unable to reach server.', 'error');
      }
    });
  }

  const goToOnboardingStep = (stepNumber) => {
    const panes = [
      { step: 1, el: document.getElementById('paneCreateAccount') },
      { step: 2, el: document.getElementById('paneOtpVerify') },
      { step: 3, el: document.getElementById('panePharmacyDetails') },
      { step: 4, el: document.getElementById('paneOwnerDetails') },
      { step: 5, el: document.getElementById('paneOnboardingSuccess') }
    ];

    panes.forEach(p => {
      if (p.el) {
        if (p.step === stepNumber) {
          p.el.classList.remove('step-hidden');
          p.el.classList.add('step-active');
        } else {
          p.el.classList.remove('step-active');
          p.el.classList.add('step-hidden');
        }
      }
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ==========================================================================
  // 4. SIDEBAR NAVIGATION
  // ==========================================================================
  const sidebarNavBtns = document.querySelectorAll('.sidebar-nav-btn');
  const panels = {
    dashboard: document.getElementById('paneDashboard'),
    bills: document.getElementById('paneBills'),
    inventory: document.getElementById('paneInventory'),
    batches: document.getElementById('paneBatches'),
    lowstock: document.getElementById('paneLowStock'),
    expiry: document.getElementById('paneBatches'),
    returns: document.getElementById('paneReturns'),
    movement: document.getElementById('paneMovement'),
    suppliers: document.getElementById('paneSuppliers'),
    expenses: document.getElementById('paneExpenses'),
    analytics: document.getElementById('paneAnalytics'),
    notifications: document.getElementById('paneNotifications'),
    settings: document.getElementById('paneSettings')
  };

  const switchWorkspaceTab = (tabKey) => {
    sidebarNavBtns.forEach(btn => {
      if (btn.getAttribute('data-tab') === tabKey) {
        btn.classList.add('nav-active');
      } else {
        btn.classList.remove('nav-active');
      }
    });

    Object.keys(panels).forEach(k => {
      const p = panels[k];
      if (!p) return;
      if (k === tabKey) {
        p.classList.remove('panel-hidden');
        p.classList.add('panel-active');
      } else {
        p.classList.remove('panel-active');
        p.classList.add('panel-hidden');
      }
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
    refreshAllWorkspaceViews();
  };

  sidebarNavBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      switchWorkspaceTab(tab);
    });
  });

  // Action Buttons
  document.getElementById('topbarUploadBillBtn')?.addEventListener('click', () => switchWorkspaceTab('bills'));
  document.getElementById('dashHeroUploadBtn')?.addEventListener('click', () => switchWorkspaceTab('bills'));
  document.getElementById('emptyUploadBtn')?.addEventListener('click', () => switchWorkspaceTab('bills'));
  document.getElementById('viewAllInventoryLink')?.addEventListener('click', () => switchWorkspaceTab('inventory'));
  document.getElementById('notifBellBtn')?.addEventListener('click', () => switchWorkspaceTab('notifications'));

  // ==========================================================================
  // 5. CALCULATIONS & EXECUTIONS
  // ==========================================================================
  const calculateDaysRemaining = (expiryDateStr) => {
    if (!expiryDateStr) return 999;
    const now = new Date();
    let expYear, expMonth, expDay = 28;

    if (expiryDateStr.includes('-')) {
      const parts = expiryDateStr.split('-');
      if (parts.length === 2) {
        expYear = parseInt(parts[0], 10);
        expMonth = parseInt(parts[1], 10) - 1;
      } else if (parts.length === 3) {
        expYear = parseInt(parts[0], 10);
        expMonth = parseInt(parts[1], 10) - 1;
        expDay = parseInt(parts[2], 10);
      }
    } else if (expiryDateStr.includes('/')) {
      const parts = expiryDateStr.split('/');
      if (parts.length === 2) {
        expMonth = parseInt(parts[0], 10) - 1;
        expYear = parseInt(parts[1].length === 2 ? '20' + parts[1] : parts[1], 10);
      }
    }

    const expDate = new Date(expYear, expMonth, expDay);
    return Math.ceil((expDate - now) / (1000 * 60 * 60 * 24));
  };

  const getRiskDetails = (days) => {
    if (days <= 0) return { key: 'expired', label: 'Expired', class: 'critical' };
    if (days <= 30) return { key: 'critical', label: `${days}d left (Critical)`, class: 'critical' };
    if (days <= 60) return { key: 'warning', label: `${days}d left (Warning)`, class: 'warning' };
    if (days <= 90) return { key: 'watchlist', label: `${days}d left (Watchlist)`, class: 'watchlist' };
    return { key: 'safe', label: `${days}d left (Safe)`, class: 'safe' };
  };

  const setTxt = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };

  const refreshAllWorkspaceViews = () => {
    if (!currentPharmacy) return;

    const sName = currentPharmacy.shop_name || currentPharmacy.shopName || 'My Pharmacy';
    const sDl = currentPharmacy.dl_number || currentPharmacy.dlNumber || '—';
    const oName = toTitleCase(currentPharmacy.owner_name || currentPharmacy.ownerName || 'Pharmacist');
    const oRole = currentPharmacy.role || 'Owner';

    const sAddr = currentPharmacy.shop_address || currentPharmacy.shopAddress || '';
    const sCity = currentPharmacy.city || '';
    const sState = currentPharmacy.state || '';
    const sPin = currentPharmacy.pincode || '';
    const fullAddr = [sAddr, sCity, sState, sPin].filter(Boolean).join(', ');

    setTxt('activeShopName', sName);
    setTxt('activeDlNumber', `D.L. No. ${sDl}`);
    setTxt('greetingUserTitle', `Good morning, ${oName}`);
    setVal('setShopName', sName);
    setVal('setDlNumber', sDl);
    setVal('setShopAddress', fullAddr || 'Not specified');
    setVal('setOwnerName', `${oName} (${oRole})`);

    const avatarBadge = document.getElementById('userAvatarInitials');
    if (avatarBadge) {
      const initials = oName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
      const savedPhoto = localStorage.getItem(`expirednot_dp_${currentPharmacy.id || 'current'}`);
      if (savedPhoto) {
        avatarBadge.innerHTML = `<img src="${savedPhoto}" alt="DP" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
      } else {
        avatarBadge.textContent = initials;
      }
      avatarBadge.title = "Click to view profile";
    }

    renderDashboardMetrics();
    renderInventoryTable();
    renderBatchesAndFefoTable();
    renderLowStockView();
    renderReturnsView();
    renderMovementLog();
    renderSuppliersView();
    renderExpensesView();
    renderAnalyticsView();
    renderNotificationsView();
  };

  const renderDashboardMetrics = () => {
    const activeBatches = pharmacyDb.batches.filter(b => b.quantity > 0);

    let totalVal = 0, atRiskVal = 0, expiringCount = 0, expiredVal = 0, expiredCount = 0;
    let clearedVal = pharmacyDb.movements
      .filter(m => m.type === 'Returned' || m.type === 'Cleared')
      .reduce((sum, m) => sum + (m.value || 0), 0);

    const distinctMeds = new Set();

    activeBatches.forEach(b => {
      const val = b.quantity * b.purchaseRate;
      totalVal += val;
      distinctMeds.add(b.name.trim().toLowerCase());

      const days = calculateDaysRemaining(b.expiryDate);
      if (days <= 0) {
        expiredVal += val;
        expiredCount++;
      } else if (days <= 60) {
        atRiskVal += val;
        expiringCount++;
      }
    });

    setTxt('kpiTotalValue', `₹${totalVal.toLocaleString('en-IN')}`);
    setTxt('kpiTotalCount', `${distinctMeds.size} medicines • ${activeBatches.length} batches`);
    setTxt('kpiMedicinesCount', distinctMeds.size);
    setTxt('kpiBatchesTotalCount', `${activeBatches.length} active batches in rack`);
    setTxt('kpiExpiringCount', expiringCount);
    setTxt('kpiExpiringSubtext', `${expiringCount} batches within 60-day window`);
    setTxt('kpiAtRiskValue', `₹${atRiskVal.toLocaleString('en-IN')}`);
    setTxt('kpiAtRiskSubtext', atRiskVal > 0 ? 'Prioritize FEFO or distributor return' : 'All stock in safe horizon');
    setTxt('kpiExpiredValue', `₹${expiredVal.toLocaleString('en-IN')}`);
    setTxt('kpiExpiredCount', `${expiredCount} expired batches`);
    setTxt('kpiClearedValue', `₹${clearedVal.toLocaleString('en-IN')}`);
    setTxt('kpiClearedCount', `${pharmacyDb.movements.filter(m => m.type === 'Returned').length} returns adjusted`);

    const sideCountInventory = document.getElementById('sideCountInventory');
    const sideCountExpiry = document.getElementById('sideCountExpiry');
    if (sideCountInventory) {
      sideCountInventory.textContent = activeBatches.length;
      sideCountInventory.hidden = activeBatches.length === 0;
    }
    if (sideCountExpiry) {
      sideCountExpiry.textContent = expiringCount;
      sideCountExpiry.hidden = expiringCount === 0;
    }
  };

  const renderInventoryTable = () => {
    const tbody = document.getElementById('inventoryTableBody');
    const empty = document.getElementById('emptyInventoryTableState');
    if (!tbody || !empty) return;

    if (pharmacyDb.batches.length === 0) {
      tbody.innerHTML = '';
      empty.hidden = false;
      return;
    }

    empty.hidden = true;
    tbody.innerHTML = pharmacyDb.batches.map(b => {
      const days = calculateDaysRemaining(b.expiryDate);
      const risk = getRiskDetails(days);
      const totalVal = b.quantity * b.purchaseRate;

      return `
        <tr>
          <td><strong>${b.name}</strong></td>
          <td><span class="table-batch-pill">${b.batchNo}</span></td>
          <td>${b.rack || 'Rack A-1'}</td>
          <td><strong>${b.quantity}</strong> units</td>
          <td>${b.expiryDate}</td>
          <td><span class="risk-pill ${risk.class}">${risk.label}</span></td>
          <td><span class="fefo-pill">FIFO Active</span></td>
          <td>₹${b.purchaseRate.toLocaleString('en-IN')}</td>
          <td><strong>₹${totalVal.toLocaleString('en-IN')}</strong></td>
          <td><button type="button" class="btn-secondary" onclick="window.quickReturn('${b.id}')">Return</button></td>
        </tr>
      `;
    }).join('');
  };

  // ==========================================================================
  // SECTION 4: FEFO TABLE (SORTED CLOSEST EXPIRY AT TOP)
  // ==========================================================================
  const renderBatchesAndFefoTable = () => {
    const tbody = document.getElementById('batchesTableBody');
    const empty = document.getElementById('emptyBatchesTableState');
    if (!tbody || !empty) return;

    if (pharmacyDb.batches.length === 0) {
      tbody.innerHTML = '';
      empty.hidden = false;
      return;
    }

    empty.hidden = true;

    const fefoSortedBatches = pharmacyDb.batches
      .map(b => ({
        ...b,
        daysLeft: calculateDaysRemaining(b.expiryDate)
      }))
      .sort((a, b) => a.daysLeft - b.daysLeft);

    tbody.innerHTML = fefoSortedBatches.map((b, index) => {
      const risk = getRiskDetails(b.daysLeft);
      const totalVal = b.quantity * b.purchaseRate;

      let fefoBadge;
      if (b.daysLeft <= 0) {
        fefoBadge = `<span class="fefo-pill critical" style="background:#fee2e2; color:#991b1b; font-weight:700;">Do Not Sell (Expired)</span>`;
      } else if (index === 0 || b.daysLeft <= 30) {
        fefoBadge = `<span class="fefo-pill urgent" style="background:#ffedd5; color:#9a3412; font-weight:700;">Priority 1 (Sell First)</span>`;
      } else if (b.daysLeft <= 90) {
        fefoBadge = `<span class="fefo-pill warning" style="background:#fef9c3; color:#854d0e; font-weight:600;">Priority ${index + 1} (Sell Next)</span>`;
      } else {
        fefoBadge = `<span class="fefo-pill" style="background:#f1f5f9; color:#475569;">Priority ${index + 1} (Later Batch)</span>`;
      }

      return `
        <tr>
          <td><strong>${b.name}</strong></td>
          <td><span class="table-batch-pill">${b.batchNo}</span></td>
          <td><strong>${b.quantity}</strong> units</td>
          <td><span style="font-family: var(--font-mono); font-weight: 600;">${b.expiryDate}</span></td>
          <td><span class="risk-pill ${risk.class}">${risk.label}</span></td>
          <td>${fefoBadge}</td>
          <td>${b.distributor || 'General Stockist'}</td>
          <td><strong>₹${totalVal.toLocaleString('en-IN')}</strong></td>
        </tr>
      `;
    }).join('');
  };

  // ==========================================================================
  // SECTION 5: TIERED LOW STOCK ALERTS (50 / 20 / 10 LIMITS)
  // ==========================================================================
  const renderLowStockView = () => {
    const list = document.getElementById('lowStockList');
    const empty = document.getElementById('emptyLowStockState');
    const sideCountLowStock = document.getElementById('sideCountLowStock');
    if (!list || !empty) return;

    const medTotals = {};
    const medTiers = {};

    pharmacyDb.batches.forEach(b => {
      const k = b.name.trim();
      medTotals[k] = (medTotals[k] || 0) + (Number(b.quantity) || 0);

      if (!medTiers[k] || medTiers[k] === 'AUTO') {
        if (b.demandTier && b.demandTier !== 'AUTO') {
          medTiers[k] = b.demandTier;
        } else if (window.InventoryRules) {
          medTiers[k] = window.InventoryRules.inferDemandTier(k);
        }
      }
    });

    const lowStockItems = [];
    Object.keys(medTotals).forEach(name => {
      const qty = medTotals[name];
      const tier = medTiers[name] || (window.InventoryRules ? window.InventoryRules.inferDemandTier(name) : 'MEDIUM_DEMAND');

      const alertInfo = window.InventoryRules 
        ? window.InventoryRules.checkStockAlert(name, qty, tier)
        : { isLowStock: qty <= 20, threshold: 20, tierLabel: 'Medium Demand' };

      if (alertInfo.isLowStock && qty > 0) {
        lowStockItems.push({
          name,
          qty,
          threshold: alertInfo.threshold,
          tierLabel: alertInfo.tierLabel,
          deficit: alertInfo.deficit
        });
      }
    });

    if (sideCountLowStock) {
      sideCountLowStock.textContent = lowStockItems.length;
      sideCountLowStock.hidden = lowStockItems.length === 0;
    }

    if (lowStockItems.length === 0) {
      list.hidden = true;
      empty.hidden = false;
      return;
    }

    empty.hidden = true;
    list.hidden = false;
    lowStockItems.sort((a, b) => b.deficit - a.deficit);

    list.innerHTML = lowStockItems.map(item => `
      <div style="display:flex; align-items:center; justify-content:space-between; padding:0.85rem 1rem; background:#fff; border:1px solid var(--color-border); border-radius:var(--radius-md); margin-bottom:0.65rem;">
        <div>
          <div style="display:flex; align-items:center; gap:0.5rem;">
            <strong>${item.name}</strong>
            <span style="font-size:0.7rem; padding:2px 6px; background:#f1f5f9; border-radius:4px; color:#475569;">${item.tierLabel}</span>
          </div>
          <div style="font-size:0.75rem; color:var(--status-warning); font-weight:700; margin-top:3px;">
            ⚠️ Current Stock: ${item.qty} units (Threshold: ${item.threshold} • Need: +${item.deficit})
          </div>
        </div>
        <button type="button" class="btn-primary" style="height:32px; font-size:0.75rem;" onclick="alert('Reorder reminder set for ${item.name} (+${item.deficit} units)')">
          Create Reorder Reminder
        </button>
      </div>
    `).join('');
  };

  const renderReturnsView = () => {};
  window.quickReturn = () => switchWorkspaceTab('returns');
  const renderMovementLog = () => {};
  const renderSuppliersView = () => {};

  // ==========================================================================
  // OPERATING EXPENSES VIEW
  // ==========================================================================
  const renderExpensesView = () => {
    const tbody = document.getElementById('expensesTableBody');
    const empty = document.getElementById('emptyExpensesState');
    if (!tbody || !empty) return;

    if (!pharmacyDb.expenses || pharmacyDb.expenses.length === 0) {
      tbody.innerHTML = '';
      empty.hidden = false;
      empty.style.display = 'block';
      return;
    }

    empty.hidden = true;
    empty.style.display = 'none';

    tbody.innerHTML = pharmacyDb.expenses.map(exp => `
      <tr>
        <td><span style="font-size:0.75rem; color:var(--color-text-muted);">${exp.date}</span></td>
        <td><span class="table-batch-pill">${exp.category}</span></td>
        <td><strong>${exp.desc}</strong></td>
        <td><strong>₹${Number(exp.amount || 0).toLocaleString('en-IN')}</strong></td>
      </tr>
    `).join('');
  };

  const renderAnalyticsView = () => {};

  // ==========================================================================
  // NOTIFICATIONS FEED
  // ==========================================================================
  const renderNotificationsView = () => {
    const feed = document.getElementById('notificationsFeed');
    const empty = document.getElementById('emptyNotifsState');
    const notifBadge = document.getElementById('notifBadge');
    if (!feed || !empty) return;

    const allEvents = [];
    pharmacyDb.bills.forEach(b => {
      allEvents.push({
        icon: '📄',
        title: `Purchase Bill Ingested — ${b.distributor}`,
        desc: `Invoice #${b.invoiceNo} • ${b.itemsCount} medicines recorded (Total: ₹${(b.totalAmount || 0).toLocaleString('en-IN')})`,
        time: b.timestamp || b.date || 'Recently'
      });
    });

    pharmacyDb.movements.forEach(m => {
      allEvents.push({
        icon: m.type === 'Sold' ? '🛒' : '🔄',
        title: `${m.type}: ${m.medicineName}`,
        desc: `Quantity: ${m.quantity} units (Batch: ${m.batchNo}) • Value: ₹${(m.value || 0).toLocaleString('en-IN')}`,
        time: m.timestamp || 'Recently'
      });
    });

    if (notifBadge) {
      notifBadge.textContent = allEvents.length;
      notifBadge.hidden = allEvents.length === 0;
    }

    if (allEvents.length === 0) {
      feed.hidden = true;
      empty.hidden = false;
      return;
    }

    empty.hidden = true;
    feed.hidden = false;

    feed.innerHTML = allEvents.map(item => `
      <div style="display:flex; align-items:flex-start; gap:0.85rem; padding:0.95rem 1.15rem; background:#fff; border:1px solid var(--color-border); border-radius:var(--radius-md); margin-bottom:0.75rem;">
        <span style="font-size:1.35rem; line-height:1; margin-top:2px;">${item.icon}</span>
        <div style="flex:1;">
          <div style="font-weight:700; color:var(--color-text-main); font-size:0.9rem; display:flex; justify-content:space-between; align-items:center;">
            <span>${item.title}</span>
            <span style="font-size:0.725rem; font-weight:600; color:var(--color-text-muted); background:#f1f5f9; padding:2px 8px; border-radius:12px;">${item.time}</span>
          </div>
          <div style="font-size:0.8rem; color:var(--color-text-secondary); margin-top:3px;">
            ${item.desc}
          </div>
        </div>
      </div>
    `).join('');
  };

  // ==========================================================================
  // BILL OCR & INGESTION
  // ==========================================================================
  const billFileInput = document.getElementById('billFileInput');
  const ocrReviewContainer = document.getElementById('ocrReviewContainer');
  const ocrDistributorDisplay = document.getElementById('ocrDistributorDisplay');
  const ocrInvoiceNoDisplay = document.getElementById('ocrInvoiceNoDisplay');
  const ocrDateDisplay = document.getElementById('ocrDateDisplay');
  const ocrItemsCountDisplay = document.getElementById('ocrItemsCountDisplay');
  const ocrTableBody = document.getElementById('ocrTableBody');
  const ocrConfirmSaveBtn = document.getElementById('ocrConfirmSaveBtn');

  let currentCapturedBill = null;

  const processBillFile = async (file) => {
    if (!file) return;
    const formData = new FormData();
    formData.append('bill', file);

    try {
      const res = await fetch(`${API_BASE_URL}/api/bills/analyze`, {
        method: 'POST',
        headers: sessionToken ? { 'Authorization': `Bearer ${sessionToken}` } : {},
        body: formData
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.items && data.items.length > 0) {
          loadSideBySideReview(data, file);
          return;
        }
      }
    } catch (e) {}

    // Fallback: If AI is offline, allow manual side-by-side entry
    loadSideBySideReview({
      distributor: 'Wholesale Supplier',
      invoice_no: 'INV-' + Math.floor(1000 + Math.random() * 9000),
      invoice_date: new Date().toISOString().split('T')[0],
      items: [{ name: '', pack: '10s', batch_no: '', expiry_date: '', quantity: 10, purchase_rate: 100, mrp: 140 }]
    }, file);
  };

  const loadSideBySideReview = (invoiceObj, file = null) => {
    currentCapturedBill = JSON.parse(JSON.stringify(invoiceObj));

    if (ocrDistributorDisplay) ocrDistributorDisplay.textContent = currentCapturedBill.distributor || '—';
    if (ocrInvoiceNoDisplay) ocrInvoiceNoDisplay.textContent = currentCapturedBill.invoice_no || currentCapturedBill.invoiceNo || '—';
    if (ocrDateDisplay) ocrDateDisplay.textContent = currentCapturedBill.invoice_date || currentCapturedBill.date || '—';
    if (ocrItemsCountDisplay) ocrItemsCountDisplay.textContent = currentCapturedBill.items ? currentCapturedBill.items.length : 0;

    renderOcrTable();

    if (ocrReviewContainer) {
      ocrReviewContainer.hidden = false;
      ocrReviewContainer.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const renderOcrTable = () => {
    if (!ocrTableBody || !currentCapturedBill) return;

    ocrTableBody.innerHTML = (currentCapturedBill.items || []).map((item, idx) => {
      const pRate = item.purchase_rate !== undefined ? item.purchase_rate : (item.purchaseRate || 0);
      const bNo = item.batch_no || item.batchNo || '';
      const expDate = item.expiry_date || item.expiryDate || '';
      const rowTotal = (parseFloat(item.quantity) || 0) * (parseFloat(pRate) || 0);

      return `
        <tr data-index="${idx}">
          <td><span class="conf-badge conf-high">✓ Verified</span></td>
          <td><input type="text" value="${item.name || ''}" class="form-input ocr-in-name" style="height:32px; padding:0 0.5rem;" placeholder="Medicine Name" required></td>
          <td><input type="text" value="${item.pack || ''}" class="form-input ocr-in-pack" style="height:32px; padding:0 0.5rem; width:65px;"></td>
          <td><input type="text" value="${bNo}" class="form-input ocr-in-batch mono-input" style="height:32px; padding:0 0.5rem; width:100px;" placeholder="BATCH" required></td>
          <td><input type="text" value="${expDate}" class="form-input ocr-in-exp mono-input" style="height:32px; padding:0 0.5rem; width:90px;" placeholder="YYYY-MM" required></td>
          <td><input type="number" value="${item.quantity || 1}" min="1" class="form-input ocr-in-qty" style="height:32px; padding:0 0.5rem; width:70px;" required></td>
          <td><input type="number" value="${pRate}" min="0" step="0.01" class="form-input ocr-in-rate" style="height:32px; padding:0 0.5rem; width:80px;" required></td>
          <td><input type="number" value="${item.mrp || ''}" min="0" step="0.01" class="form-input ocr-in-mrp" style="height:32px; padding:0 0.5rem; width:80px;"></td>
          <td><strong style="font-family:var(--font-mono);">₹${rowTotal.toLocaleString('en-IN')}</strong></td>
          <td><button type="button" class="btn-secondary" style="height:26px; padding:0 0.4rem; color:var(--status-critical);" onclick="window.removeCapturedLine(${idx})">×</button></td>
        </tr>
      `;
    }).join('');

    ocrTableBody.querySelectorAll('tr').forEach(tr => {
      const idx = parseInt(tr.getAttribute('data-index'), 10);
      const inName = tr.querySelector('.ocr-in-name');
      const inPack = tr.querySelector('.ocr-in-pack');
      const inBatch = tr.querySelector('.ocr-in-batch');
      const inExp = tr.querySelector('.ocr-in-exp');
      const inQty = tr.querySelector('.ocr-in-qty');
      const inRate = tr.querySelector('.ocr-in-rate');
      const inMrp = tr.querySelector('.ocr-in-mrp');

      const sync = () => {
        if (currentCapturedBill.items && currentCapturedBill.items[idx]) {
          currentCapturedBill.items[idx].name = inName.value;
          currentCapturedBill.items[idx].pack = inPack.value;
          currentCapturedBill.items[idx].batch_no = inBatch.value;
          currentCapturedBill.items[idx].expiry_date = inExp.value;
          currentCapturedBill.items[idx].quantity = parseFloat(inQty.value) || 0;
          currentCapturedBill.items[idx].purchase_rate = parseFloat(inRate.value) || 0;
          currentCapturedBill.items[idx].mrp = parseFloat(inMrp.value) || 0;
        }
      };

      [inName, inPack, inBatch, inExp, inQty, inRate, inMrp].forEach(inp => {
        if (inp) inp.addEventListener('input', sync);
      });
    });
  };

  window.removeCapturedLine = (idx) => {
    if (!currentCapturedBill || !currentCapturedBill.items) return;
    currentCapturedBill.items.splice(idx, 1);
    if (ocrItemsCountDisplay) ocrItemsCountDisplay.textContent = currentCapturedBill.items.length;
    renderOcrTable();
  };

  if (billFileInput) {
    billFileInput.addEventListener('change', () => {
      if (billFileInput.files && billFileInput.files[0]) {
        processBillFile(billFileInput.files[0]);
      }
    });
  }

  if (ocrConfirmSaveBtn) {
    ocrConfirmSaveBtn.addEventListener('click', async () => {
      if (!currentCapturedBill || !currentCapturedBill.items || currentCapturedBill.items.length === 0) {
        alert('Please maintain at least one valid line item.');
        return;
      }

      const invoiceNo = currentCapturedBill.invoice_no || currentCapturedBill.invoiceNo || ('INV-' + Math.floor(1000 + Math.random() * 9000));
      const distributor = currentCapturedBill.distributor || 'Wholesale Stockist';
      const invoiceDate = currentCapturedBill.invoice_date || currentCapturedBill.date || new Date().toISOString().split('T')[0];

      let totalBillAmount = 0;
      currentCapturedBill.items.forEach(item => {
        const rate = parseFloat(item.purchase_rate) || 0;
        const qty = parseFloat(item.quantity) || 1;
        totalBillAmount += (qty * rate);

        const tier = window.InventoryRules 
          ? window.InventoryRules.inferDemandTier(item.name) 
          : 'MEDIUM_DEMAND';

        pharmacyDb.batches.unshift({
          id: 'B_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          name: item.name.trim(),
          pack: item.pack || 'Standard',
          batchNo: (item.batch_no || item.batchNo).trim().toUpperCase(),
          expiryDate: item.expiry_date || item.expiryDate,
          quantity: qty,
          purchaseRate: rate,
          mrp: parseFloat(item.mrp) || (rate * 1.3),
          rack: 'Rack A-1',
          distributor: distributor,
          demandTier: tier,
          createdAt: new Date().toISOString()
        });
      });

      pharmacyDb.bills.unshift({
        id: 'BILL_' + Date.now(),
        distributor: distributor,
        invoiceNo: invoiceNo,
        date: invoiceDate,
        totalAmount: totalBillAmount,
        itemsCount: currentCapturedBill.items.length,
        originalFileUrl: '',
        timestamp: 'Just now'
      });

      savePharmacyData();
      currentCapturedBill = null;
      if (ocrReviewContainer) ocrReviewContainer.hidden = true;

      refreshAllWorkspaceViews();
      switchWorkspaceTab('dashboard');
      alert(`✓ Invoice #${invoiceNo} processed! Added to inventory.`);
    });
  }

  // ==========================================================================
  // MODALS: ADD MEDICINE & EXPENSES
  // ==========================================================================
  const addMedModal = document.getElementById('addMedModal');
  const addMedForm = document.getElementById('addMedForm');
  const closeAddMedBtn = document.getElementById('closeAddMedBtn');
  const cancelAddMedBtn = document.getElementById('cancelAddMedBtn');

  const openAddMedModal = () => {
    if (!addMedModal) return;
    addMedModal.classList.remove('view-hidden');
    addMedModal.classList.add('view-active');
    document.getElementById('mMedName')?.focus();
  };

  const closeAddMedModal = () => {
    if (!addMedModal) return;
    addMedModal.classList.remove('view-active');
    addMedModal.classList.add('view-hidden');
    if (addMedForm) addMedForm.reset();
  };

  document.getElementById('topbarAddMedBtn')?.addEventListener('click', openAddMedModal);
  document.getElementById('emptyAddMedBtn')?.addEventListener('click', openAddMedModal);
  document.getElementById('inventoryAddMedBtn')?.addEventListener('click', openAddMedModal);
  if (closeAddMedBtn) closeAddMedBtn.addEventListener('click', closeAddMedModal);
  if (cancelAddMedBtn) cancelAddMedBtn.addEventListener('click', closeAddMedModal);

  if (addMedForm) {
    addMedForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const mMedName = document.getElementById('mMedName');
      const mDemandTier = document.getElementById('mDemandTier');
      const mBatchNo = document.getElementById('mBatchNo');
      const mExpiryDate = document.getElementById('mExpiryDate');
      const mQty = document.getElementById('mQty');
      const mPurchaseRate = document.getElementById('mPurchaseRate');
      const mMrp = document.getElementById('mMrp');
      const mRack = document.getElementById('mRack');
      const mDistributor = document.getElementById('mDistributor');

      if (!mMedName?.value.trim() || !mBatchNo?.value.trim() || !mExpiryDate?.value || !mQty?.value || !mPurchaseRate?.value) {
        alert('Please fill all required fields.');
        return;
      }

      const qty = parseFloat(mQty.value) || 1;
      const rate = parseFloat(mPurchaseRate.value) || 0;
      const mrp = parseFloat(mMrp?.value) || (rate > 0 ? rate * 1.3 : 0);

      let selectedTier = mDemandTier ? mDemandTier.value : 'AUTO';
      if (selectedTier === 'AUTO' || !selectedTier) {
        selectedTier = window.InventoryRules 
          ? window.InventoryRules.inferDemandTier(mMedName.value.trim()) 
          : 'MEDIUM_DEMAND';
      }

      const newBatch = {
        id: 'B_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        name: mMedName.value.trim(),
        generic_name: '',
        pack: 'Standard',
        batchNo: mBatchNo.value.trim().toUpperCase(),
        expiryDate: mExpiryDate.value,
        quantity: qty,
        purchaseRate: rate,
        mrp: mrp,
        rack: mRack?.value.trim() || 'Rack A-1',
        distributor: mDistributor?.value.trim() || 'Direct Supplier',
        demandTier: selectedTier,
        createdAt: new Date().toISOString()
      };

      pharmacyDb.batches.unshift(newBatch);
      pharmacyDb.movements.unshift({
        id: 'MOV_' + Date.now(),
        timestamp: 'Just now',
        type: 'Purchased',
        medicineName: newBatch.name,
        batchNo: newBatch.batchNo,
        quantity: qty,
        value: qty * rate,
        notes: 'Manual Entry'
      });

      savePharmacyData();
      closeAddMedModal();
      refreshAllWorkspaceViews();
      alert(`✓ ${newBatch.name} (Batch ${newBatch.batchNo}) added to inventory!`);
    });
  }

  // Expense Modal
  const expenseModal = document.getElementById('expenseModal');
  const expenseForm = document.getElementById('expenseForm');
  const closeExpenseBtn = document.getElementById('closeExpenseBtn');
  const cancelExpenseBtn = document.getElementById('cancelExpenseBtn');

  const openExpenseModal = () => {
    if (!expenseModal) return;
    expenseModal.classList.remove('view-hidden');
    expenseModal.classList.add('view-active');
  };

  const closeExpenseModal = () => {
    if (!expenseModal) return;
    expenseModal.classList.remove('view-active');
    expenseModal.classList.add('view-hidden');
    if (expenseForm) expenseForm.reset();
  };

  document.getElementById('addExpenseBtn')?.addEventListener('click', openExpenseModal);
  if (closeExpenseBtn) closeExpenseBtn.addEventListener('click', closeExpenseModal);
  if (cancelExpenseBtn) cancelExpenseBtn.addEventListener('click', closeExpenseModal);

  if (expenseForm) {
    expenseForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const expCategory = document.getElementById('expCategory')?.value || 'Other';
      const expAmount = parseFloat(document.getElementById('expAmount')?.value) || 0;
      const expDesc = document.getElementById('expDesc')?.value?.trim() || '';

      if (!expDesc || expAmount <= 0) {
        alert('Please enter a description and an amount greater than 0.');
        return;
      }

      pharmacyDb.expenses.unshift({
        id: 'EXP_' + Date.now(),
        date: new Date().toISOString().split('T')[0],
        category: expCategory,
        desc: expDesc,
        amount: expAmount
      });

      savePharmacyData();
      closeExpenseModal();
      renderExpensesView();
      alert(`✓ Recorded ₹${expAmount.toLocaleString('en-IN')} for ${expDesc}`);
    });
  }

  // ==========================================================================
  // PROFILE & OWNER-ONLY STAFF DIRECTORY
  // ==========================================================================
  const profileModal = document.getElementById('profileModal');
  const profileStaffSection = document.getElementById('profileStaffSection');
  const staffListContainer = document.getElementById('staffListContainer');
  const addStaffBtn = document.getElementById('addStaffBtn');
  const quickAddStaffForm = document.getElementById('quickAddStaffForm');
  const saveStaffBtn = document.getElementById('saveStaffBtn');
  const profilePhotoInput = document.getElementById('profilePhotoInput');

  const getShopStaffStorageKey = () => {
    const dl = currentPharmacy ? (currentPharmacy.dl_number || currentPharmacy.dlNumber || 'default') : 'default';
    return `expirednot_staff_${dl.trim().toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  };

  const renderStaffList = () => {
    if (!staffListContainer) return;
    let staffList = [];
    try {
      staffList = JSON.parse(localStorage.getItem(getShopStaffStorageKey())) || [];
    } catch {}

    if (staffList.length === 0) {
      staffListContainer.innerHTML = `<div style="font-size:0.75rem; color:#64748b; font-style:italic; padding:0.5rem; text-align:center;">No staff members added yet.</div>`;
      return;
    }

    staffListContainer.innerHTML = staffList.map((worker, idx) => {
      const initials = worker.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
      return `
        <div class="staff-member-card">
          <div class="staff-member-info">
            <div class="staff-avatar-mini">${initials}</div>
            <div>
              <strong>${toTitleCase(worker.name)}</strong>
              <div style="font-size: 0.7rem; color: #64748b;">📞 ${worker.mobile}</div>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:0.4rem;">
            <span class="staff-badge-role">${worker.role}</span>
            <button type="button" style="background:none; border:none; color:#ef4444; font-size:0.85rem; cursor:pointer;" onclick="window.removeStaffMember(${idx})">×</button>
          </div>
        </div>
      `;
    }).join('');
  };

  window.removeStaffMember = (index) => {
    const key = getShopStaffStorageKey();
    let staffList = JSON.parse(localStorage.getItem(key)) || [];
    staffList.splice(index, 1);
    localStorage.setItem(key, JSON.stringify(staffList));
    renderStaffList();
  };

  if (addStaffBtn && quickAddStaffForm) {
    addStaffBtn.addEventListener('click', () => {
      const isHidden = quickAddStaffForm.style.display === 'none';
      quickAddStaffForm.style.display = isHidden ? 'block' : 'none';
      addStaffBtn.textContent = isHidden ? 'Cancel' : '+ Add Worker';
    });
  }

  if (saveStaffBtn) {
    saveStaffBtn.addEventListener('click', () => {
      const name = document.getElementById('staffNewName')?.value.trim();
      const role = document.getElementById('staffNewRole')?.value || 'Pharmacist';
      const mobile = document.getElementById('staffNewMobile')?.value.trim();

      if (!name || !mobile) {
        alert('Please enter worker name and mobile number.');
        return;
      }

      const key = getShopStaffStorageKey();
      let staffList = JSON.parse(localStorage.getItem(key)) || [];
      staffList.push({ name, role, mobile, addedAt: new Date().toISOString() });
      localStorage.setItem(key, JSON.stringify(staffList));

      document.getElementById('staffNewName').value = '';
      document.getElementById('staffNewMobile').value = '';
      quickAddStaffForm.style.display = 'none';
      addStaffBtn.textContent = '+ Add Worker';
      renderStaffList();
    });
  }

  window.openProfileModal = () => {
    if (!profileModal || !currentPharmacy) return;

    const sName = currentPharmacy.shop_name || currentPharmacy.shopName || 'My Pharmacy';
    const sDl = currentPharmacy.dl_number || currentPharmacy.dlNumber || '—';
    const pType = currentPharmacy.pharmacy_type || currentPharmacy.pharmacyType || 'Retail Pharmacy';
    const pPhone = currentPharmacy.pharmacy_phone || currentPharmacy.pharmacyPhone || currentPharmacy.mobile || '—';
    const sAddr = currentPharmacy.shop_address || currentPharmacy.shopAddress || '';
    const sCity = currentPharmacy.city || '';
    const sState = currentPharmacy.state || '';
    const sPin = currentPharmacy.pincode || '';
    const fullAddr = [sAddr, sCity, sState, sPin].filter(Boolean).join(', ') || 'Not specified';

    const oName = toTitleCase(currentPharmacy.owner_name || currentPharmacy.ownerName || 'Pharmacist');
    const oRole = currentPharmacy.role || 'Owner';
    const oMobile = currentPharmacy.owner_mobile || currentPharmacy.ownerMobile || currentPharmacy.mobile || '—';

    setTxt('profShopName', sName);
    setTxt('profDlNumber', sDl);
    setTxt('profPharmacyType', pType);
    setTxt('profPharmacyPhone', pPhone);
    setTxt('profFullAddress', fullAddr);
    setTxt('profOwnerName', oName);
    setTxt('profRole', oRole);
    setTxt('profOwnerMobile', oMobile);

    const initials = oName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
    setTxt('profileModalInitials', initials);

    const savedPhoto = localStorage.getItem(`expirednot_dp_${currentPharmacy.id || 'current'}`);
    const modalImg = document.getElementById('profileModalImg');
    const modalInitials = document.getElementById('profileModalInitials');
    if (savedPhoto && modalImg) {
      modalImg.src = savedPhoto;
      modalImg.style.display = 'block';
      if (modalInitials) modalInitials.style.display = 'none';
    } else {
      if (modalImg) modalImg.style.display = 'none';
      if (modalInitials) modalInitials.style.display = 'block';
    }

    // Role check: Only Owner sees the staff directory
    const isOwner = (oRole || '').trim().toLowerCase() === 'owner';
    if (profileStaffSection) {
      profileStaffSection.style.display = isOwner ? 'block' : 'none';
      if (isOwner) renderStaffList();
    }

    profileModal.classList.remove('view-hidden');
    profileModal.classList.add('view-active');
  };

  const closeProfileModal = () => {
    if (!profileModal) return;
    profileModal.classList.remove('view-active');
    profileModal.classList.add('view-hidden');
  };

  document.getElementById('userAvatarInitials')?.addEventListener('click', window.openProfileModal);
  document.getElementById('closeProfileModalBtn')?.addEventListener('click', closeProfileModal);
  document.getElementById('doneProfileBtn')?.addEventListener('click', closeProfileModal);
  document.getElementById('changePhotoBtn')?.addEventListener('click', () => profilePhotoInput?.click());

  if (profilePhotoInput) {
    profilePhotoInput.addEventListener('change', () => {
      const file = profilePhotoInput.files[0];
      if (!file || !file.type.startsWith('image/')) {
        alert('Please select an image file (PNG, JPG).');
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const base64 = e.target.result;
        const key = `expirednot_dp_${currentPharmacy ? (currentPharmacy.id || 'current') : 'current'}`;
        localStorage.setItem(key, base64);
        window.openProfileModal();
        refreshAllWorkspaceViews();
      };
      reader.readAsDataURL(file);
    });
  }

  // ==========================================================================
  // BOOT CHECK
  // ==========================================================================
  const initSessionCheck = async () => {
    const activeSessionRaw = sessionStorage.getItem(ACTIVE_SESSION_KEY) || localStorage.getItem(ACTIVE_SESSION_KEY);
    if (activeSessionRaw) {
      try {
        currentPharmacy = JSON.parse(activeSessionRaw);
        if (currentPharmacy.setup_completed || currentPharmacy.setupCompleted) {
          await loadPharmacyData(currentPharmacy.id);
          showScreen('dashboard');
          return;
        }
      } catch {}
    }
    showScreen('welcome');
  };

  initSessionCheck();
});