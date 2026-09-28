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

  // Production Backend API URL Resolution:
  // When running locally (localhost / 127.0.0.1), use relative '' so it talks to local server.py.
  // When deployed to Vercel (or any other production host), route directly to deployed Render backend.
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

  let currentPharmacy = null;
  let sessionToken = localStorage.getItem(ACTIVE_TOKEN_KEY) || sessionStorage.getItem(ACTIVE_TOKEN_KEY) || null;

  // Real Database for Active Pharmacy (STRICT ZERO DEFAULT)
  let pharmacyDb = {
    batches: [],       // { id, name, generic_name, pack, batchNo, expiryDate, quantity, purchaseRate, mrp, rack, distributor, createdAt }
    bills: [],         // { id, distributor, invoiceNo, date, totalAmount, itemsCount, originalFileUrl, timestamp }
    movements: [],     // { id, timestamp, type, medicineName, batchNo, quantity, value, notes }
    expenses: [],      // { id, date, category, desc, amount }
    notifications: [], // { id, text, type, timestamp, read: false }
    activity: []       // { id, text, timestamp }
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

  /**
   * Automatic Firebase -> Backend Session Bridge:
   * Obtains a fresh Firebase ID Token via getIdToken(forceRefresh) and exchanges it with /api/auth/firebase
   * to ensure a valid backend SQLite session token exists in sessionStorage and localStorage.
   */
  const ensureBackendAuthSession = async (forceRefresh = false) => {
    if (sessionToken && !forceRefresh) {
      return sessionToken;
    }

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

    if (!fbUser) {
      return sessionToken;
    }

    try {
      // Obtain fresh Firebase ID Token
      const idToken = await fbUser.getIdToken(forceRefresh);

      const payload = {
        email: fbUser.email,
        uid: fbUser.uid,
        name: fbUser.displayName || (currentPharmacy ? currentPharmacy.owner_name : ''),
        id_token: idToken
      };

      // Restore existing pharmacy details if backend restarted
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
          console.log('[AUTH BRIDGE] Successfully created/refreshed backend session token.');
          return sessionToken;
        }
      }
    } catch (err) {
      console.warn('[AUTH BRIDGE] Error refreshing backend session token:', err);
    }

    return sessionToken;
  };

  /**
   * Wrapper around fetch() that attaches backend session authorization headers and
   * automatically re-bridges Firebase -> backend on HTTP 401 Unauthorized with a single retry.
   */
  const authenticatedFetch = async (url, options = {}, retryCount = 0) => {
    if (!sessionToken) {
      await ensureBackendAuthSession(false);
    }

    const opt = { ...options };
    const baseHeaders = { 'Content-Type': 'application/json' };
    opt.headers = {
      ...baseHeaders,
      ...(options.headers || {}),
      ...(sessionToken ? { 'Authorization': `Bearer ${sessionToken}` } : {})
    };

    let res = await fetch(url, opt);

    // Auto-Retry ONCE on 401 Unauthorized by re-bridging Firebase -> Backend
    if (res.status === 401 && retryCount === 0) {
      console.log('[AUTH BRIDGE] Backend returned 401 Unauthorized. Auto re-bridging Firebase session...');
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
    
    // 0. Fetch authoritative profile from SQLite backend
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
    } catch (e) {
      console.warn('Could not refresh profile from backend:', e);
    }

    // 1. Fetch real batches from SQLite backend
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
            createdAt: b.created_at
          }));
        }
      }
    } catch (e) {
      console.warn('Backend offline, using scoped local storage cache:', e);
    }

    // 2. Fetch real bills from SQLite backend
    try {
      const billsRes = await authenticatedFetch(`${API_BASE_URL}/api/bills`);
      if (billsRes.ok) {
        const billsData = await billsRes.json();
        if (billsData.bills) {
          pharmacyDb.bills = billsData.bills.map(b => {
            const sellerObj = b.seller_data && typeof b.seller_data === 'object' ? b.seller_data : {};
            return {
              id: b.id,
              distributor: b.distributor,
              seller_data: b.seller_data,
              sellerName: sellerObj.name || b.distributor,
              place: sellerObj.place || sellerObj.city || sellerObj.state || '',
              address: sellerObj.address || '',
              gstin: sellerObj.gstin || '',
              dlNumber: sellerObj.dl_number || '',
              phone: sellerObj.phone || '',
              invoiceNo: b.invoice_no,
              date: b.invoice_date,
              totalAmount: b.total_amount,
              taxes_data: b.taxes_data,
              buyer_data: b.buyer_data,
              originalFileUrl: b.original_file_path,
              fileName: b.file_name,
              fileType: b.file_type,
              itemsCount: b.items_count || (b.items ? b.items.length : 1),
              items: (b.items || []).map(it => ({
                name: it.name,
                generic_name: it.generic_name,
                pack: it.pack,
                batch_no: it.batch_no,
                expiry_date: it.expiry_date,
                quantity: it.quantity,
                purchase_rate: it.purchase_rate,
                mrp: it.mrp,
                rack: it.rack
              })),
              timestamp: b.created_at ? new Date(b.created_at * 1000).toLocaleDateString() : 'Recent',
              createdAt: b.created_at
            };
          });
        }
      }
    } catch (e) {
      console.warn('Could not fetch bills from backend:', e);
    }

    // 3. Fetch real notifications from SQLite backend
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
    } catch (e) {
      console.warn('Could not fetch notifications from backend:', e);
    }

    // 4. Fetch real stock movements from SQLite backend
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
    } catch (e) {
      console.warn('Could not fetch movements from backend:', e);
    }

    // 5. Fallback scoped local storage
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
  // 2. ROUTING & PROTECTED ROUTE ENFORCER
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
    // Protected Route Check
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
          goToOnboardingStep(3); // Resume pharmacy setup
          return;
        }
      } catch {
        showScreen('auth');
        return;
      }

      // If Firebase Auth currentUser is present with password provider and not verified, reject access
      if (window.firebaseAuth && window.firebaseAuth.currentUser) {
        const u = window.firebaseAuth.currentUser;
        const isPasswordProvider = u.providerData && u.providerData.some(p => p.providerId === 'password');
        if (isPasswordProvider && !u.emailVerified) {
          showScreen('signup');
          goToOnboardingStep(2);
          showOtpNotice('Verify your email before continuing.', 'error');
          return;
        }
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

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('#enterAppBtn');
    if (btn) {
      e.preventDefault();
      showScreen('auth');
    }
  });

  if (backToWelcomeBtn) backToWelcomeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    showScreen('welcome');
  });
  if (createAccountLink) createAccountLink.addEventListener('click', () => {
    googleConnectedUser = null;
    const googleConnectedPill = document.getElementById('googleConnectedPill');
    if (googleConnectedPill) googleConnectedPill.hidden = true;
    showScreen('signup');
    goToOnboardingStep(1);
  });
  if (cancelSignupBtn) cancelSignupBtn.addEventListener('click', () => showScreen('auth'));
  if (signupCancelBtn) signupCancelBtn.addEventListener('click', () => showScreen('auth'));
  if (goToDashboardBtn) goToDashboardBtn.addEventListener('click', () => showScreen('dashboard'));

  // Listen to hash changes for deep linking & protected route checks
  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.replace('#', '');
    if (hash === 'dashboard' || hash === 'inventory' || hash === 'bills') {
      showScreen('dashboard');
    } else if (hash === 'signup') {
      showScreen('signup');
    } else if (hash === 'auth') {
      showScreen('auth');
    }
  });

  // ==========================================================================
  // 3. REAL AUTHENTICATION & LOGIN CONTROLLER
  // ==========================================================================
  const loginForm = document.getElementById('loginForm');
  const loginIdentifierInput = document.getElementById('loginIdentifierInput');
  const passwordInput = document.getElementById('passwordInput');
  const togglePasswordBtn = document.getElementById('togglePasswordBtn');
  const authNotice = document.getElementById('authNotice');
  const signInButton = document.getElementById('signInButton');
  const signInBtnText = document.getElementById('signInBtnText');
  const forgotPasswordLink = document.getElementById('forgotPasswordLink');

  if (togglePasswordBtn && passwordInput) {
    togglePasswordBtn.addEventListener('click', () => {
      const isPass = passwordInput.type === 'password';
      passwordInput.type = isPass ? 'text' : 'password';
      togglePasswordBtn.setAttribute('aria-label', isPass ? 'Hide password' : 'Show password');
    });
  }

  const showAuthNotice = (message, type = 'error', showCreateBtn = false) => {
    if (!authNotice) return;
    authNotice.className = `auth-notice ${type}`;
    authNotice.innerHTML = `
      <span>${message}</span>
      ${showCreateBtn ? '<button type="button" class="auth-notice-btn" id="authNoticeCreateBtn">Create Account →</button>' : ''}
    `;
    authNotice.hidden = false;

    const btn = document.getElementById('authNoticeCreateBtn');
    if (btn) {
      btn.addEventListener('click', () => {
        showScreen('signup');
        goToOnboardingStep(1);
      });
    }
  };

  const hideAuthNotice = () => {
    if (!authNotice) return;
    authNotice.hidden = true;
  };

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideAuthNotice();

      const identifier = loginIdentifierInput ? loginIdentifierInput.value.trim() : '';
      const pass = passwordInput ? passwordInput.value : '';

      if (!identifier) {
        showAuthNotice('Please enter your registered Email address or 10-digit Mobile number.', 'error');
        return;
      }
      if (!pass) {
        showAuthNotice('Please enter your password.', 'error');
        return;
      }

      if (signInButton) signInButton.disabled = true;
      if (signInBtnText) signInBtnText.textContent = 'Signing in…';

      // 1. Attempt Firebase Authentication if identifier is an email
      if (identifier.includes('@')) {
        if (!window.firebaseAuth) {
          if (signInButton) signInButton.disabled = false;
          if (signInBtnText) signInBtnText.textContent = 'Sign in with Email & Password';
          showAuthNotice('Firebase Authentication is not ready. Please refresh the page.', 'error');
          return;
        }

        try {
          const userCredential = await window.firebaseAuth.signInWithEmailAndPassword(identifier, pass);
          const fbUser = userCredential.user;
          if (fbUser) {
            await fbUser.reload();
            if (!fbUser.emailVerified) {
              if (signInButton) signInButton.disabled = false;
              if (signInBtnText) signInBtnText.textContent = 'Sign in with Email & Password';

              pendingRegistration.email = fbUser.email;
              pendingRegistration.password = pass;

              const maskedDisplay = document.getElementById('maskedEmailDisplay');
              if (maskedDisplay) maskedDisplay.textContent = maskEmail(fbUser.email);

              showScreen('signup');
              goToOnboardingStep(2);
              showOtpNotice('Verify your email before continuing.', 'error');
              return;
            }

            // User email IS verified -> proceed to backend session bridge
            const bridgeRes = await fetch(`${API_BASE_URL}/api/auth/firebase`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: fbUser.email, uid: fbUser.uid, name: fbUser.displayName || '' })
            });
            const data = await bridgeRes.json();

            if (signInButton) signInButton.disabled = false;
            if (signInBtnText) signInBtnText.textContent = 'Sign in with Email & Password';

            if (!bridgeRes.ok) {
              showAuthNotice(data.error || 'Authentication bridge failed.', 'error');
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
            return;
          }
        } catch (fbErr) {
          if (signInButton) signInButton.disabled = false;
          if (signInBtnText) signInBtnText.textContent = 'Sign in with Email & Password';

          console.warn('Firebase login error:', fbErr.code, fbErr.message);
          if (fbErr.code === 'auth/wrong-password' || fbErr.code === 'auth/invalid-credential') {
            showAuthNotice('Incorrect password. Please try again.', 'error');
          } else if (fbErr.code === 'auth/user-not-found') {
            showAuthNotice('No account found with this email. Please check credentials or create an account.', 'error', true);
          } else if (fbErr.code === 'auth/invalid-email') {
            showAuthNotice('Please enter a valid email address.', 'error');
          } else if (fbErr.code === 'auth/too-many-requests') {
            showAuthNotice('Access to this account has been temporarily disabled due to many failed attempts.', 'error');
          } else {
            showAuthNotice(fbErr.message || 'Authentication failed. Please check credentials.', 'error');
          }
          return;
        }
      }

      // 2. Server Authentication Fallback for Phone / Mobile Number Identifiers
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
          if (data.needs_verification) {
            pendingRegistration.email = data.email;
            const maskedDisplay = document.getElementById('maskedEmailDisplay');
            if (maskedDisplay) maskedDisplay.textContent = maskEmail(data.email);
            showScreen('signup');
            goToOnboardingStep(2);
            showOtpNotice('Verify your email before continuing.', 'error');
            return;
          }
          showAuthNotice(data.error || 'Authentication failed. Please check credentials.', 'error', data.not_found);
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
        showAuthNotice('Unable to reach EXPIREDNOT server. Please check your internet connection.', 'error');
      }
    });
  }

  if (forgotPasswordLink) {
    forgotPasswordLink.addEventListener('click', async (e) => {
      e.preventDefault();
      const identifier = loginIdentifierInput ? loginIdentifierInput.value.trim().toLowerCase() : '';
      if (!identifier || !identifier.includes('@')) {
        showAuthNotice('Please enter your email address in the Email field above, then click Forgot password.', 'info');
        if (loginIdentifierInput) loginIdentifierInput.focus();
        return;
      }
      if (window.firebaseAuth) {
        try {
          await window.firebaseAuth.sendPasswordResetEmail(identifier);
          showAuthNotice(`Password reset instructions sent to ${maskEmail(identifier)}. Check your inbox.`, 'info');
          return;
        } catch (err) {
          if (err.code === 'auth/user-not-found') {
            showAuthNotice('No account found with this email.', 'error');
            return;
          }
          showAuthNotice(err.message || 'Unable to send password reset email.', 'error');
          return;
        }
      }
      showAuthNotice('Password reset instructions sent to your email.', 'info');
    });
  }

  // ==========================================================================
  // 4. OFFICIAL GOOGLE OAUTH WITH FIREBASE & IDENTITY SERVICES
  // ==========================================================================
  const googleModal = document.getElementById('googleModal');
  const googleModalBackdrop = document.getElementById('googleModalBackdrop');
  const closeGoogleModalBtn = document.getElementById('closeGoogleModalBtn');
  const googleSignInBtn = document.getElementById('googleSignInBtn');
  const googleAuthForm = document.getElementById('googleAuthForm');
  const googleEmailInput = document.getElementById('googleEmailInput');
  const googleEmailError = document.getElementById('googleEmailError');
  const googleLoadingState = document.getElementById('googleLoadingState');
  const googleLoadingText = document.getElementById('googleLoadingText');
  const googleForgotEmailBtn = document.getElementById('googleForgotEmailBtn');

  let googleConnectedUser = null;
  let serverGoogleClientId = '';
  let isGoogleConfigured = false;
  let isGeminiConfigured = false;

  const fetchAuthConfig = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/config/auth`);
      const data = await res.json();
      serverGoogleClientId = data.google_client_id || '';
      isGoogleConfigured = data.google_configured || false;
      isGeminiConfigured = data.gemini_configured || false;

      if (isGoogleConfigured && window.google && window.google.accounts && window.google.accounts.id) {
        google.accounts.id.initialize({
          client_id: serverGoogleClientId,
          callback: handleGoogleCredentialResponse,
          auto_select: false
        });
      }
    } catch {}
  };

  const handleGoogleCredentialResponse = async (response) => {
    if (!response || !response.credential) return;
    try {
      showAuthNotice('Authenticating with Google…', 'info');
      const res = await fetch(`${API_BASE_URL}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: response.credential })
      });
      const data = await res.json();
      if (!res.ok) {
        showAuthNotice(data.error || 'Google authentication failed.', 'error');
        return;
      }

      sessionToken = data.session_token;
      sessionStorage.setItem(ACTIVE_TOKEN_KEY, sessionToken);
      currentPharmacy = data.user;
      sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(currentPharmacy));

      if (data.existing_user) {
        showAuthNotice('Welcome back! Logging in…', 'success');
        setTimeout(async () => {
          await loadPharmacyData(currentPharmacy.id);
          showScreen('dashboard');
        }, 300);
      } else {
        // New Google user -> Advance to Pharmacy Setup (email already verified by Google)
        pendingRegistration.email = data.email || data.user.email;
        pendingRegistration.isGoogle = true;
        const googleConnectedPill = document.getElementById('googleConnectedPill');
        const googleEmailDisplay = document.getElementById('googleEmailConnectedDisplay');
        const regOwnerName = document.getElementById('regOwnerName');
        if (googleConnectedPill) googleConnectedPill.hidden = false;
        if (googleEmailDisplay) googleEmailDisplay.textContent = pendingRegistration.email;
        if (regOwnerName && data.name) regOwnerName.value = data.name;

        showScreen('signup');
        goToOnboardingStep(3); // Direct to Pharmacy Details
      }
    } catch (e) {
      showAuthNotice('Unable to reach EXPIREDNOT server. Please check your internet connection.', 'error');
    }
  };

  const openGoogleModal = () => {
    // If official Google Client ID is configured in .env, prompt official GIS
    if (isGoogleConfigured && window.google && window.google.accounts && window.google.accounts.id) {
      try {
        google.accounts.id.prompt();
        return;
      } catch {}
    }

    if (!googleModal) return;
    googleModal.classList.remove('view-hidden');
    googleModal.classList.add('view-active');
    if (googleAuthForm) googleAuthForm.hidden = false;
    if (googleLoadingState) googleLoadingState.hidden = true;
    if (googleEmailError) googleEmailError.hidden = true;
    if (googleEmailInput) {
      googleEmailInput.value = '';
      setTimeout(() => googleEmailInput.focus(), 100);
    }
  };

  const closeGoogleModal = () => {
    if (!googleModal) return;
    googleModal.classList.remove('view-active');
    googleModal.classList.add('view-hidden');
  };

  const handleFirebaseGoogleSignIn = async (e) => {
    if (e) e.preventDefault();
    if (window.firebaseAuth && window.googleAuthProvider) {
      try {
        showAuthNotice('Signing in with Google…', 'info');
        const result = await window.firebaseAuth.signInWithPopup(window.googleAuthProvider);
        const fbUser = result.user;
        if (!fbUser) return;

        const email = fbUser.email;
        const name = fbUser.displayName || '';
        const uid = fbUser.uid;

        const res = await fetch(`${API_BASE_URL}/api/auth/firebase`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, uid, name })
        });
        const data = await res.json();

        if (!res.ok) {
          showAuthNotice(data.error || 'Google authentication failed.', 'error');
          return;
        }

        sessionToken = data.session_token;
        sessionStorage.setItem(ACTIVE_TOKEN_KEY, sessionToken);
        currentPharmacy = data.user;
        sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(currentPharmacy));

        if (data.existing_user && !data.needs_setup) {
          showAuthNotice('Welcome back! Logging in…', 'success');
          setTimeout(async () => {
            await loadPharmacyData(currentPharmacy.id);
            showScreen('dashboard');
          }, 300);
        } else {
          // New Google user -> Advance to Pharmacy Setup (email verified by Google)
          pendingRegistration.email = email;
          pendingRegistration.name = name;
          pendingRegistration.isGoogle = true;

          const googleConnectedPill = document.getElementById('googleConnectedPill');
          const googleEmailDisplay = document.getElementById('googleEmailConnectedDisplay');
          const regOwnerName = document.getElementById('regOwnerName');
          if (googleConnectedPill) googleConnectedPill.hidden = false;
          if (googleEmailDisplay) googleEmailDisplay.textContent = email;
          if (regOwnerName && name) regOwnerName.value = name;

          showScreen('signup');
          goToOnboardingStep(3); // Direct to Pharmacy Details
        }
        return;
      } catch (err) {
        console.warn('Firebase Google Auth note:', err);
        if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
          hideAuthNotice();
          return;
        }
        if (err.code === 'auth/popup-blocked') {
          openGoogleModal();
          return;
        }
        showAuthNotice(err.message || 'Google sign-in failed. Please try again.', 'error');
        return;
      }
    }
    openGoogleModal();
  };

  if (googleSignInBtn) {
    googleSignInBtn.addEventListener('click', handleFirebaseGoogleSignIn);
  }
  if (googleModalBackdrop) googleModalBackdrop.addEventListener('click', closeGoogleModal);
  if (closeGoogleModalBtn) closeGoogleModalBtn.addEventListener('click', closeGoogleModal);

  if (googleForgotEmailBtn) {
    googleForgotEmailBtn.addEventListener('click', () => {
      alert('Please enter your Google account email to continue.');
    });
  }

  const handleGoogleAuthSubmission = async (email, name = '') => {
    if (googleEmailError) googleEmailError.hidden = true;
    if (googleAuthForm) googleAuthForm.hidden = true;
    if (googleLoadingState) {
      googleLoadingState.hidden = false;
      if (googleLoadingText) googleLoadingText.textContent = `Connecting ${email} with Google…`;
    }

    try {
      const res = await fetch(`${API_BASE_URL}/api/auth/firebase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name })
      });
      const data = await res.json();

      closeGoogleModal();

      if (!res.ok) {
        showAuthNotice(data.error || 'Google authentication failed.', 'error');
        return;
      }

      sessionToken = data.session_token;
      sessionStorage.setItem(ACTIVE_TOKEN_KEY, sessionToken);
      currentPharmacy = data.user;
      sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(currentPharmacy));

      if (data.existing_user) {
        showAuthNotice('Welcome back! Logging in…', 'success');
        setTimeout(async () => {
          await loadPharmacyData(currentPharmacy.id);
          showScreen('dashboard');
        }, 300);
      } else {
        // New Google user -> Advance to Pharmacy Setup (email verified by Google)
        pendingRegistration.email = email;
        pendingRegistration.name = name;
        pendingRegistration.isGoogle = true;

        const googleConnectedPill = document.getElementById('googleConnectedPill');
        const googleEmailDisplay = document.getElementById('googleEmailConnectedDisplay');
        const regOwnerName = document.getElementById('regOwnerName');
        if (googleConnectedPill) googleConnectedPill.hidden = false;
        if (googleEmailDisplay) googleEmailDisplay.textContent = email;
        if (regOwnerName && name) regOwnerName.value = name;

        showScreen('signup');
        goToOnboardingStep(3); // Direct to Pharmacy Details
      }
    } catch (e) {
      closeGoogleModal();
      showAuthNotice('Failed to connect with Google. Please try again.', 'error');
    }
  };

  if (googleAuthForm) {
    googleAuthForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = googleEmailInput ? googleEmailInput.value.trim() : '';

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (googleEmailError) googleEmailError.hidden = false;
        return;
      }

      const inferredName = email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      handleGoogleAuthSubmission(email, inferredName);
    });
  }

  // ==========================================================================
  // 5. SIGNUP & REAL BACKEND EMAIL OTP VERIFICATION FLOW
  // ==========================================================================
  const paneCreateAccount = document.getElementById('paneCreateAccount');
  const paneOtpVerify = document.getElementById('paneOtpVerify');
  const panePharmacyDetails = document.getElementById('panePharmacyDetails');
  const paneOwnerDetails = document.getElementById('paneOwnerDetails');
  const paneOnboardingSuccess = document.getElementById('paneOnboardingSuccess');

  const pStep1Indicator = document.getElementById('pStep1Indicator');
  const pStep2Indicator = document.getElementById('pStep2Indicator');
  const pStep3Indicator = document.getElementById('pStep3Indicator');
  const progressBarFill = document.getElementById('progressBarFill');
  const onboardingNavTagline = document.getElementById('onboardingNavTagline');

  let pendingRegistration = {
    email: '',
    password: '',
    shopName: '',
    dlNumber: '',
    pharmacyType: '',
    pharmacyPhone: '',
    ownerName: '',
    role: '',
    ownerMobile: ''
  };

  let resendInterval = null;
  let resendCountdown = 30;
  let currentDemoOtp = '';
  let otpTimerInterval = null;
  let otpExpiresAt = null;

  const maskEmail = (emailStr) => {
    if (!emailStr || !emailStr.includes('@')) return 'your email';
    const [name, domain] = emailStr.split('@');
    const maskedName = name.length > 2 ? name[0] + '***' + name.slice(-1) : name[0] + '***';
    return `${maskedName}@${domain}`;
  };

  const startOtpTimer = (seconds = 600) => {
    if (otpTimerInterval) clearInterval(otpTimerInterval);
    otpExpiresAt = Date.now() + (seconds * 1000);

    const updateCountdown = () => {
      const remaining = Math.max(0, Math.floor((otpExpiresAt - Date.now()) / 1000));
      const mins = String(Math.floor(remaining / 60)).padStart(2, '0');
      const secs = String(remaining % 60).padStart(2, '0');
      const timerText = document.getElementById('otpExpiryCountdownText');
      const timerBadge = document.getElementById('otpTimerBadge');
      
      if (timerText) {
        timerText.textContent = `Code expires in ${mins}:${secs}`;
      }

      if (remaining <= 0) {
        if (otpTimerInterval) clearInterval(otpTimerInterval);
        if (timerBadge) timerBadge.classList.add('expired');
        if (timerText) timerText.textContent = 'Code expired';
        showOtpNotice('This verification code has expired. Generate a new code.', 'error');
        if (verifyOtpBtn) verifyOtpBtn.disabled = true;
      } else {
        if (timerBadge) timerBadge.classList.remove('expired');
      }
    };

    updateCountdown();
    otpTimerInterval = setInterval(updateCountdown, 1000);
  };

  const goToOnboardingStep = (stepNumber) => {
    const panes = [
      { step: 1, el: paneCreateAccount, pct: '25%', label: 'Account' },
      { step: 2, el: paneOtpVerify, pct: '50%', label: 'Verify Email' },
      { step: 3, el: panePharmacyDetails, pct: '75%', label: 'Pharmacy Setup' },
      { step: 4, el: paneOwnerDetails, pct: '90%', label: 'Owner Details' },
      { step: 5, el: paneOnboardingSuccess, pct: '100%', label: 'All Set' }
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

    const cur = panes.find(p => p.step === stepNumber);
    if (progressBarFill && cur) progressBarFill.style.width = cur.pct;
    if (onboardingNavTagline && cur) onboardingNavTagline.textContent = cur.label;

    if (pStep1Indicator) pStep1Indicator.className = stepNumber === 1 ? 'progress-step-item active' : 'progress-step-item completed';
    if (pStep2Indicator) pStep2Indicator.className = stepNumber === 2 ? 'progress-step-item active' : (stepNumber > 2 ? 'progress-step-item completed' : 'progress-step-item');
    if (pStep3Indicator) pStep3Indicator.className = stepNumber >= 3 ? 'progress-step-item active' : 'progress-step-item';

    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Step 1: Create Account Form
  const createAccountForm = document.getElementById('createAccountForm');
  const regEmailInput = document.getElementById('regEmailInput');
  const regPassInput = document.getElementById('regPassInput');
  const regConfirmPassInput = document.getElementById('regConfirmPassInput');
  const sendOtpBtn = document.getElementById('sendOtpBtn');
  const sendOtpBtnText = document.getElementById('sendOtpBtnText');
  const signupNotice = document.getElementById('signupNotice');

  if (createAccountForm) {
    createAccountForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (signupNotice) signupNotice.hidden = true;

      const email = regEmailInput ? regEmailInput.value.trim() : '';
      const pass = regPassInput ? regPassInput.value : '';
      const confPass = regConfirmPassInput ? regConfirmPassInput.value : '';

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showSignupNotice('Please enter a valid email address.', 'error');
        return;
      }
      if (!pass || pass.length < 8) {
        showSignupNotice('Password must be at least 8 characters.', 'error');
        return;
      }
      if (pass !== confPass) {
        showSignupNotice('Passwords do not match.', 'error');
        return;
      }

      if (sendOtpBtn) sendOtpBtn.disabled = true;
      if (sendOtpBtnText) sendOtpBtnText.textContent = 'Creating account…';

      // 1. Firebase Email/Password Sign-Up & Immediate Verification Email Dispatch
      if (window.firebaseAuth) {
        try {
          const userCredential = await window.firebaseAuth.createUserWithEmailAndPassword(email, pass);
          const fbUser = userCredential.user;

          // Immediately dispatch real Firebase email verification link
          await fbUser.sendEmailVerification();

          pendingRegistration.email = email;
          pendingRegistration.password = pass;

          if (sendOtpBtn) sendOtpBtn.disabled = false;
          if (sendOtpBtnText) sendOtpBtnText.textContent = 'Continue to Verification →';

          const maskedDisplay = document.getElementById('maskedEmailDisplay');
          if (maskedDisplay) maskedDisplay.textContent = maskEmail(email);

          goToOnboardingStep(2);
          showOtpNotice("We've sent a verification link to your email address. Please open your inbox and click the link before continuing.", 'info');
          startResendCooldown(60);
          return;
        } catch (fbErr) {
          if (sendOtpBtn) sendOtpBtn.disabled = false;
          if (sendOtpBtnText) sendOtpBtnText.textContent = 'Continue to Verification →';

          if (fbErr.code === 'auth/email-already-in-use') {
            showSignupNotice('An account already exists with this email. Please sign in instead.', 'error', true);
            return;
          } else if (fbErr.code === 'auth/weak-password') {
            showSignupNotice('Password is too weak. Please use at least 8 characters.', 'error');
            return;
          } else if (fbErr.code === 'auth/invalid-email') {
            showSignupNotice('Please enter a valid email address.', 'error');
            return;
          } else {
            showSignupNotice(fbErr.message || 'Unable to create account. Please try again.', 'error');
            return;
          }
        }
      } else {
        if (sendOtpBtn) sendOtpBtn.disabled = false;
        if (sendOtpBtnText) sendOtpBtnText.textContent = 'Continue to Verification →';
        showSignupNotice('Firebase Authentication is not available. Please check internet connection.', 'error');
      }
    });
  }

  const showSignupNotice = (msg, type = 'error', showSignInBtn = false) => {
    if (!signupNotice) return;
    signupNotice.className = `auth-notice ${type}`;
    signupNotice.innerHTML = `
      <span>${msg}</span>
      ${showSignInBtn ? '<button type="button" class="auth-notice-btn" id="signupNoticeSignInBtn">Sign In →</button>' : ''}
    `;
    signupNotice.hidden = false;

    const btn = document.getElementById('signupNoticeSignInBtn');
    if (btn) {
      btn.addEventListener('click', () => {
        showScreen('auth');
      });
    }
  };

  // Step 2: Email Verification Link Controller
  const verifyOtpBtn = document.getElementById('verifyOtpBtn');
  const verifyOtpBtnText = document.getElementById('verifyOtpBtnText');
  const otpNotice = document.getElementById('otpNotice');
  const resendOtpBtn = document.getElementById('resendOtpBtn');
  const resendTimerText = document.getElementById('resendTimerText');
  const changeEmailBtn = document.getElementById('changeEmailBtn');

  let resendCooldownInterval = null;
  let resendCooldownRemaining = 0;

  const startResendCooldown = (seconds = 60) => {
    if (resendCooldownInterval) clearInterval(resendCooldownInterval);
    resendCooldownRemaining = seconds;
    if (resendOtpBtn) resendOtpBtn.disabled = true;
    if (resendTimerText) resendTimerText.textContent = `Resend in ${resendCooldownRemaining}s`;

    resendCooldownInterval = setInterval(() => {
      resendCooldownRemaining -= 1;
      if (resendCooldownRemaining <= 0) {
        clearInterval(resendCooldownInterval);
        if (resendOtpBtn) resendOtpBtn.disabled = false;
        if (resendTimerText) resendTimerText.textContent = 'Resend Verification Email';
      } else {
        if (resendTimerText) resendTimerText.textContent = `Resend in ${resendCooldownRemaining}s`;
      }
    }, 1000);
  };

  const showOtpNotice = (msg, type = 'error') => {
    if (!otpNotice) return;
    otpNotice.className = `auth-notice ${type}`;
    otpNotice.textContent = msg;
    otpNotice.hidden = false;
  };

  // "Check Verification" Handler
  if (verifyOtpBtn) {
    verifyOtpBtn.addEventListener('click', async () => {
      if (verifyOtpBtn) verifyOtpBtn.disabled = true;
      if (verifyOtpBtnText) verifyOtpBtnText.textContent = 'Checking…';

      try {
        let currentUser = window.firebaseAuth ? window.firebaseAuth.currentUser : null;
        if (!currentUser && pendingRegistration.email && pendingRegistration.password) {
          try {
            const cred = await window.firebaseAuth.signInWithEmailAndPassword(pendingRegistration.email, pendingRegistration.password);
            currentUser = cred.user;
          } catch (e) {
            console.warn('Sign-in check note:', e);
          }
        }

        if (currentUser) {
          await currentUser.reload();
          if (currentUser.emailVerified) {
            showOtpNotice('✓ Email verified', 'success');

            // Bridge authenticated & verified user to SQLite backend
            const res = await fetch(`${API_BASE_URL}/api/auth/firebase`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: currentUser.email, uid: currentUser.uid, name: '' })
            });
            const data = await res.json();

            if (verifyOtpBtn) verifyOtpBtn.disabled = false;
            if (verifyOtpBtnText) verifyOtpBtnText.textContent = 'Check Verification';

            if (!res.ok) {
              showOtpNotice(data.error || 'Failed to initialize session. Please try again.', 'error');
              return;
            }

            sessionToken = data.session_token;
            sessionStorage.setItem(ACTIVE_TOKEN_KEY, sessionToken);
            currentPharmacy = data.user;
            sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(currentPharmacy));

            setTimeout(() => {
              if (data.user && (data.user.setup_completed || data.user.setupCompleted)) {
                loadPharmacyData(currentPharmacy.id);
                showScreen('dashboard');
              } else {
                goToOnboardingStep(3); // Proceed to Pharmacy Details
              }
            }, 350);
            return;
          } else {
            if (verifyOtpBtn) verifyOtpBtn.disabled = false;
            if (verifyOtpBtnText) verifyOtpBtnText.textContent = 'Check Verification';
            showOtpNotice('Your email is still not verified. Please click the verification link sent to your email.', 'error');
            return;
          }
        } else {
          if (verifyOtpBtn) verifyOtpBtn.disabled = false;
          if (verifyOtpBtnText) verifyOtpBtnText.textContent = 'Check Verification';
          showOtpNotice('No active session found. Please enter your email and password to continue.', 'error');
        }
      } catch (err) {
        if (verifyOtpBtn) verifyOtpBtn.disabled = false;
        if (verifyOtpBtnText) verifyOtpBtnText.textContent = 'Check Verification';
        showOtpNotice('Unable to check verification status. Please try again.', 'error');
      }
    });
  }

  // "Resend Verification Email" Handler
  if (resendOtpBtn) {
    resendOtpBtn.addEventListener('click', async () => {
      if (resendCooldownRemaining > 0) return;
      if (resendOtpBtn) resendOtpBtn.disabled = true;
      if (resendTimerText) resendTimerText.textContent = 'Sending…';

      try {
        let currentUser = window.firebaseAuth ? window.firebaseAuth.currentUser : null;
        if (!currentUser && pendingRegistration.email && pendingRegistration.password) {
          try {
            const cred = await window.firebaseAuth.signInWithEmailAndPassword(pendingRegistration.email, pendingRegistration.password);
            currentUser = cred.user;
          } catch (e) {}
        }

        if (currentUser) {
          await currentUser.sendEmailVerification();
          showOtpNotice('Verification email sent. Please check your inbox.', 'info');
          startResendCooldown(60);
        } else {
          showOtpNotice('Unable to send verification email. Please enter your details and try again.', 'error');
          if (resendOtpBtn) resendOtpBtn.disabled = false;
          if (resendTimerText) resendTimerText.textContent = 'Resend Verification Email';
        }
      } catch (err) {
        console.warn('Resend verification error:', err);
        if (resendOtpBtn) resendOtpBtn.disabled = false;
        if (resendTimerText) resendTimerText.textContent = 'Resend Verification Email';
        if (err.code === 'auth/too-many-requests') {
          showOtpNotice('Too many requests. Please wait a few moments before trying again.', 'error');
          startResendCooldown(60);
        } else {
          showOtpNotice(err.message || 'Failed to resend verification email.', 'error');
        }
      }
    });
  }

  // "Change Email" Handler
  if (changeEmailBtn) {
    changeEmailBtn.addEventListener('click', () => {
      showScreen('signup');
      goToOnboardingStep(1);
    });
  }

  // Step 3: Pharmacy Details Form (With Physical Shop Address)
  const pharmacyDetailsForm = document.getElementById('pharmacyDetailsForm');
  const regShopName = document.getElementById('regShopName');
  const regDlNumber = document.getElementById('regDlNumber');
  const regShopAddress = document.getElementById('regShopAddress');
  const regCity = document.getElementById('regCity');
  const regState = document.getElementById('regState');
  const regPincode = document.getElementById('regPincode');
  const regPharmacyType = document.getElementById('regPharmacyType');
  const regPharmacyPhone = document.getElementById('regPharmacyPhone');
  const pharmacyDetailsBackBtn = document.getElementById('pharmacyDetailsBackBtn');

  if (pharmacyDetailsBackBtn) {
    pharmacyDetailsBackBtn.addEventListener('click', () => {
      goToOnboardingStep(2);
    });
  }

  if (pharmacyDetailsForm) {
    pharmacyDetailsForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const sName = regShopName ? regShopName.value.trim() : '';
      const dlNo = regDlNumber ? regDlNumber.value.trim() : '';
      const sAddr = regShopAddress ? regShopAddress.value.trim() : '';
      const sCity = regCity ? regCity.value.trim() : '';
      const sState = regState ? regState.value.trim() : '';
      const sPin = regPincode ? regPincode.value.trim() : '';
      const pType = regPharmacyType ? regPharmacyType.value : '';
      const pPhone = regPharmacyPhone ? regPharmacyPhone.value.trim() : '';

      if (!sName || !dlNo || !sAddr || !sCity || !sState || !sPin || !pType || !pPhone) {
        alert('Please fill all required pharmacy details including shop full address.');
        return;
      }

      pendingRegistration.shopName = sName;
      pendingRegistration.dlNumber = dlNo;
      pendingRegistration.shopAddress = sAddr;
      pendingRegistration.city = sCity;
      pendingRegistration.state = sState;
      pendingRegistration.pincode = sPin;
      pendingRegistration.pharmacyType = pType;
      pendingRegistration.pharmacyPhone = pPhone;

      const regOwnerMobile = document.getElementById('regOwnerMobile');
      if (regOwnerMobile && !regOwnerMobile.value) {
        regOwnerMobile.value = pendingRegistration.pharmacyPhone;
      }

      goToOnboardingStep(4); // Proceed to Owner Details
    });
  }

  // Step 4: Owner Details Form
  const ownerDetailsForm = document.getElementById('ownerDetailsForm');
  const regOwnerName = document.getElementById('regOwnerName');
  const regOwnerRole = document.getElementById('regOwnerRole');
  const regOwnerMobile = document.getElementById('regOwnerMobile');
  const ownerDetailsBackBtn = document.getElementById('ownerDetailsBackBtn');
  const finishSetupBtn = document.getElementById('finishSetupBtn');
  const finishSetupBtnText = document.getElementById('finishSetupBtnText');

  if (ownerDetailsBackBtn) ownerDetailsBackBtn.addEventListener('click', () => goToOnboardingStep(3));

  if (ownerDetailsForm) {
    ownerDetailsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!regOwnerName.value.trim() || !regOwnerRole.value || !regOwnerMobile.value.trim()) {
        alert('Please fill all required owner details.');
        return;
      }

      pendingRegistration.ownerName = regOwnerName.value.trim();
      pendingRegistration.role = regOwnerRole.value;
      pendingRegistration.ownerMobile = regOwnerMobile.value.trim();

      if (finishSetupBtn) finishSetupBtn.disabled = true;
      if (finishSetupBtnText) finishSetupBtnText.textContent = 'Configuring workspace…';

      try {
        const res = await fetch(`${API_BASE_URL}/api/onboarding/complete`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            shop_name: pendingRegistration.shopName,
            dl_number: pendingRegistration.dlNumber,
            shop_address: pendingRegistration.shopAddress,
            city: pendingRegistration.city,
            state: pendingRegistration.state,
            pincode: pendingRegistration.pincode,
            pharmacy_type: pendingRegistration.pharmacyType,
            owner_name: pendingRegistration.ownerName,
            role: pendingRegistration.role,
            mobile: pendingRegistration.ownerMobile
          })
        });
        const data = await res.json();

        if (finishSetupBtn) finishSetupBtn.disabled = false;
        if (finishSetupBtnText) finishSetupBtnText.textContent = 'Finish Setup →';

        if (!res.ok) {
          alert(data.error || 'Failed to complete pharmacy setup.');
          return;
        }

        currentPharmacy = data.user;
        sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(currentPharmacy));

        // Initialize STRICT ZERO Clean Database
        pharmacyDb = {
          batches: [],
          bills: [],
          movements: [],
          expenses: [],
          notifications: [
            {
              id: 'NOTIF_INIT',
              text: `Welcome to EXPIREDNOT, ${currentPharmacy.shop_name || currentPharmacy.shopName}! Your workspace is ready.`,
              type: 'system',
              timestamp: 'Just now',
              read: false
            }
          ],
          activity: []
        };
        savePharmacyData();

        // Show Success Screen
        const successTitle = document.getElementById('successWelcomeShopTitle');
        if (successTitle) successTitle.textContent = `Welcome to EXPIREDNOT, ${currentPharmacy.shop_name || currentPharmacy.shopName}`;
        goToOnboardingStep(5);
      } catch (err) {
        if (finishSetupBtn) finishSetupBtn.disabled = false;
        if (finishSetupBtnText) finishSetupBtnText.textContent = 'Finish Setup →';
        alert('Unable to reach EXPIREDNOT server. Please check your internet connection.');
      }
    });
  }

  // ==========================================================================
  // 6. VERTICAL LEFT SIDEBAR & WORKSPACE NAVIGATION
  // ==========================================================================
  const sidebarNavBtns = document.querySelectorAll('.sidebar-nav-btn');
  const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
  const appSidebar = document.getElementById('appSidebar');
  const sidebarBackdrop = document.getElementById('sidebarBackdrop');

  const panels = {
    dashboard: document.getElementById('paneDashboard'),
    bills: document.getElementById('paneBills'),
    billhistory: document.getElementById('paneBillHistory'),
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

    if (appSidebar) appSidebar.classList.remove('sidebar-open');
    if (sidebarBackdrop) sidebarBackdrop.classList.remove('active');

    window.scrollTo({ top: 0, behavior: 'smooth' });
    refreshAllWorkspaceViews();
  };

  sidebarNavBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      switchWorkspaceTab(tab);
    });
  });

  if (sidebarToggleBtn && appSidebar && sidebarBackdrop) {
    sidebarToggleBtn.addEventListener('click', () => {
      appSidebar.classList.toggle('sidebar-open');
      sidebarBackdrop.classList.toggle('active');
    });
    sidebarBackdrop.addEventListener('click', () => {
      appSidebar.classList.remove('sidebar-open');
      sidebarBackdrop.classList.remove('active');
    });
  }

  // Quick Action Buttons & Topbar Modals
  const topbarUploadBillBtn = document.getElementById('topbarUploadBillBtn');
  const dashHeroUploadBtn = document.getElementById('dashHeroUploadBtn');
  const emptyUploadBtn = document.getElementById('emptyUploadBtn');
  const billHistoryUploadNavBtn = document.getElementById('billHistoryUploadNavBtn');
  const emptyBillHistoryUploadBtn = document.getElementById('emptyBillHistoryUploadBtn');
  const viewAllInventoryLink = document.getElementById('viewAllInventoryLink');
  const notifBellBtn = document.getElementById('notifBellBtn');
  const notifDropdown = document.getElementById('notifDropdown');
  const userProfileBtn = document.getElementById('userProfileBtn');
  const viewAllNotifsBtn = document.getElementById('viewAllNotifsBtn');
  const markAllNotifsReadBtn = document.getElementById('markAllNotifsReadBtn');
  const markAllNotifsFeedBtn = document.getElementById('markAllNotifsFeedBtn');

  if (topbarUploadBillBtn) topbarUploadBillBtn.addEventListener('click', () => switchWorkspaceTab('bills'));
  if (dashHeroUploadBtn) dashHeroUploadBtn.addEventListener('click', () => switchWorkspaceTab('bills'));
  if (emptyUploadBtn) emptyUploadBtn.addEventListener('click', () => switchWorkspaceTab('bills'));
  if (billHistoryUploadNavBtn) billHistoryUploadNavBtn.addEventListener('click', () => switchWorkspaceTab('bills'));
  if (emptyBillHistoryUploadBtn) emptyBillHistoryUploadBtn.addEventListener('click', () => switchWorkspaceTab('bills'));
  if (viewAllInventoryLink) viewAllInventoryLink.addEventListener('click', () => switchWorkspaceTab('inventory'));
  
  if (notifBellBtn) {
    notifBellBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (notifDropdown) {
        const isHidden = notifDropdown.classList.contains('view-hidden');
        if (isHidden) {
          renderNotificationsDropdown();
          notifDropdown.classList.remove('view-hidden');
        } else {
          notifDropdown.classList.add('view-hidden');
        }
      }
    });
  }

  // Close notification dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (notifDropdown && !notifDropdown.classList.contains('view-hidden')) {
      if (!notifDropdown.contains(e.target) && e.target !== notifBellBtn && !notifBellBtn.contains(e.target)) {
        notifDropdown.classList.add('view-hidden');
      }
    }
  });

  if (viewAllNotifsBtn) {
    viewAllNotifsBtn.addEventListener('click', () => {
      if (notifDropdown) notifDropdown.classList.add('view-hidden');
      switchWorkspaceTab('notifications');
    });
  }

  if (markAllNotifsReadBtn) {
    markAllNotifsReadBtn.addEventListener('click', () => window.markAllNotificationsRead());
  }

  if (markAllNotifsFeedBtn) {
    markAllNotifsFeedBtn.addEventListener('click', () => window.markAllNotificationsRead());
  }

  if (userProfileBtn) {
    userProfileBtn.addEventListener('click', () => window.openProfileModal());
  }

  // Toast notification helper
  const showAppToast = (title, message) => {
    let toast = document.getElementById('appToastBox');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'appToastBox';
      toast.style.cssText = 'position:fixed; bottom:24px; right:24px; z-index:9999; display:flex; flex-direction:column; gap:8px; pointer-events:none;';
      document.body.appendChild(toast);
    }
    const item = document.createElement('div');
    item.style.cssText = 'background:#0f172a; color:#ffffff; padding:12px 18px; border-radius:10px; box-shadow:0 10px 25px rgba(0,0,0,0.25); font-size:0.8125rem; line-height:1.4; max-width:340px; pointer-events:auto; border-left:4px solid #059669; animation:fadeInUp 0.2s ease-out;';
    item.innerHTML = `<strong style="display:block; font-size:0.875rem; color:#10b981; margin-bottom:2px;">${title}</strong><span>${message}</span>`;
    toast.appendChild(item);
    setTimeout(() => {
      item.style.opacity = '0';
      item.style.transition = 'opacity 0.3s ease-out';
      setTimeout(() => item.remove(), 300);
    }, 4000);
  };

  const formatTimeAgo = (unixSecs) => {
    if (!unixSecs) return 'Recent';
    const now = Math.floor(Date.now() / 1000);
    const diff = Math.max(0, now - unixSecs);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(unixSecs * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  // ==========================================================================
  // 7. REAL DYNAMIC CALCULATIONS & FEFO RECOMMENDATION ENGINE
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
    const diff = expDate - now;
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  };

  const getRiskDetails = (days) => {
    if (days <= 0) return { key: 'expired', label: 'Expired', class: 'critical' };
    if (days <= 30) return { key: 'critical', label: `${days}d left (Critical)`, class: 'critical' };
    if (days <= 60) return { key: 'warning', label: `${days}d left (Warning)`, class: 'warning' };
    if (days <= 90) return { key: 'watchlist', label: `${days}d left (Watchlist)`, class: 'watchlist' };
    return { key: 'safe', label: `${days}d left (Safe)`, class: 'safe' };
  };

  // Master UI Refresh Function
  const refreshAllWorkspaceViews = () => {
    if (!currentPharmacy) return;

    const sName = currentPharmacy.shop_name || currentPharmacy.shopName || 'My Pharmacy';
    const sDl = currentPharmacy.dl_number || currentPharmacy.dlNumber || '—';
    const oName = currentPharmacy.owner_name || currentPharmacy.ownerName || 'Pharmacist';
    const oRole = currentPharmacy.role || 'Owner';
    const photo = currentPharmacy.profile_photo || null;

    const activeShopName = document.getElementById('activeShopName');
    const activeDlNumber = document.getElementById('activeDlNumber');
    const greetingUserTitle = document.getElementById('greetingUserTitle');
    const setShopName = document.getElementById('setShopName');
    const setDlNumber = document.getElementById('setDlNumber');
    const setShopAddress = document.getElementById('setShopAddress');
    const setOwnerName = document.getElementById('setOwnerName');
    const userAvatarInitials = document.getElementById('userAvatarInitials');
    const userAvatarName = document.getElementById('userAvatarName');
    const userAvatarRole = document.getElementById('userAvatarRole');

    const sAddr = currentPharmacy.shop_address || currentPharmacy.shopAddress || '';
    const sCity = currentPharmacy.city || '';
    const sState = currentPharmacy.state || '';
    const sPin = currentPharmacy.pincode || '';
    const fullAddr = [sAddr, sCity, sState, sPin].filter(Boolean).join(', ');

    if (activeShopName) activeShopName.textContent = sName;
    if (activeDlNumber) activeDlNumber.textContent = `D.L. No. ${sDl}`;
    if (greetingUserTitle) greetingUserTitle.textContent = `Good morning, ${oName}`;
    if (setShopName) setShopName.value = sName;
    if (setDlNumber) setDlNumber.value = sDl;
    if (setShopAddress) setShopAddress.value = fullAddr || 'Not specified';
    if (setOwnerName) setOwnerName.value = `${oName} (${oRole})`;

    if (userAvatarName) userAvatarName.textContent = oName;
    if (userAvatarRole) userAvatarRole.textContent = currentPharmacy.pharmacy_type || currentPharmacy.pharmacyType || 'Profile & Settings';

    if (userAvatarInitials) {
      if (photo) {
        userAvatarInitials.innerHTML = `<img src="${photo}" alt="${oName}">`;
      } else {
        const initials = oName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
        userAvatarInitials.textContent = initials || 'PH';
      }
    }

    updateNotificationBadges();
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
    renderBillsHistory();
    renderBillHistoryView();
  };

  // Dashboard Metrics & Urgency Queue
  const renderDashboardMetrics = () => {
    const activeBatches = pharmacyDb.batches.filter(b => b.quantity > 0);

    let totalVal = 0;
    let atRiskVal = 0;
    let expiringCount = 0;
    let expiredVal = 0;
    let expiredCount = 0;
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

    const kpiTotalValue = document.getElementById('kpiTotalValue');
    const kpiTotalCount = document.getElementById('kpiTotalCount');
    const kpiMedicinesCount = document.getElementById('kpiMedicinesCount');
    const kpiBatchesTotalCount = document.getElementById('kpiBatchesTotalCount');
    const kpiExpiringCount = document.getElementById('kpiExpiringCount');
    const kpiExpiringSubtext = document.getElementById('kpiExpiringSubtext');
    const kpiAtRiskValue = document.getElementById('kpiAtRiskValue');
    const kpiAtRiskSubtext = document.getElementById('kpiAtRiskSubtext');
    const kpiExpiredValue = document.getElementById('kpiExpiredValue');
    const kpiExpiredCount = document.getElementById('kpiExpiredCount');
    const kpiClearedValue = document.getElementById('kpiClearedValue');
    const kpiClearedCount = document.getElementById('kpiClearedCount');

    if (kpiTotalValue) kpiTotalValue.textContent = `₹${totalVal.toLocaleString('en-IN')}`;
    if (kpiTotalCount) kpiTotalCount.textContent = `${distinctMeds.size} medicines • ${activeBatches.length} batches`;
    if (kpiMedicinesCount) kpiMedicinesCount.textContent = distinctMeds.size;
    if (kpiBatchesTotalCount) kpiBatchesTotalCount.textContent = `${activeBatches.length} active batches in rack`;

    if (kpiExpiringCount) kpiExpiringCount.textContent = expiringCount;
    if (kpiExpiringSubtext) kpiExpiringSubtext.textContent = `${expiringCount} batches within 60-day window`;

    if (kpiAtRiskValue) kpiAtRiskValue.textContent = `₹${atRiskVal.toLocaleString('en-IN')}`;
    if (kpiAtRiskSubtext) kpiAtRiskSubtext.textContent = atRiskVal > 0 ? 'Prioritize FEFO or distributor return' : 'All stock in safe horizon';

    if (kpiExpiredValue) kpiExpiredValue.textContent = `₹${expiredVal.toLocaleString('en-IN')}`;
    if (kpiExpiredCount) kpiExpiredCount.textContent = `${expiredCount} expired batches`;

    if (kpiClearedValue) kpiClearedValue.textContent = `₹${clearedVal.toLocaleString('en-IN')}`;
    if (kpiClearedCount) kpiClearedCount.textContent = `${pharmacyDb.movements.filter(m => m.type === 'Returned').length} returns adjusted`;

    const sideCountInventory = document.getElementById('sideCountInventory');
    const sideCountLowStock = document.getElementById('sideCountLowStock');
    const sideCountExpiry = document.getElementById('sideCountExpiry');
    const notifBadge = document.getElementById('notifBadge');

    if (sideCountInventory) {
      sideCountInventory.textContent = activeBatches.length;
      sideCountInventory.hidden = activeBatches.length === 0;
    }
    if (sideCountExpiry) {
      sideCountExpiry.textContent = expiringCount;
      sideCountExpiry.hidden = expiringCount === 0;
    }
    if (notifBadge) {
      const unread = pharmacyDb.notifications.filter(n => !n.read).length;
      notifBadge.textContent = unread;
      notifBadge.hidden = unread === 0;
    }

    const emptyBanner = document.getElementById('emptyInventoryBanner');
    const populatedGrid = document.getElementById('populatedDashboardGrid');

    if (activeBatches.length === 0) {
      if (emptyBanner) emptyBanner.hidden = false;
      if (populatedGrid) populatedGrid.hidden = true;
    } else {
      if (emptyBanner) emptyBanner.hidden = true;
      if (populatedGrid) populatedGrid.hidden = false;
      renderUrgentQueue(activeBatches);
      renderForecastBars(activeBatches);
    }

    renderActivityList();
  };

  const renderUrgentQueue = (batches) => {
    const tbody = document.getElementById('urgentBatchTableBody');
    if (!tbody) return;

    const medMap = {};
    batches.forEach(b => {
      const key = b.name.trim().toLowerCase();
      if (!medMap[key]) medMap[key] = [];
      medMap[key].push({ ...b, daysLeft: calculateDaysRemaining(b.expiryDate) });
    });

    const flattened = [];
    Object.keys(medMap).forEach(medKey => {
      const group = medMap[medKey].sort((a, b) => a.daysLeft - b.daysLeft);
      group.forEach((b, idx) => {
        b.isEarliest = idx === 0 && group.length > 1;
        b.isHold = idx > 0;
        flattened.push(b);
      });
    });

    const urgentItems = flattened.sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 6);

    tbody.innerHTML = urgentItems.map(b => {
      const risk = getRiskDetails(b.daysLeft);
      const atRiskVal = b.quantity * b.purchaseRate;
      const fefoBadge = b.isEarliest 
        ? `<span class="fefo-pill urgent">Dispense First (FEFO)</span>`
        : (b.isHold ? `<span class="fefo-pill" style="background:#f1f5f9;color:#64748b;">Hold (Later Expiry)</span>` : `<span class="fefo-pill">Standard</span>`);

      return `
        <tr>
          <td>
            <strong>${b.name}</strong>
            <div style="font-size: 0.725rem; color: var(--color-text-muted);">${b.pack || 'Standard'} • ${b.rack || 'Rack A-1'}</div>
          </td>
          <td><span class="table-batch-pill">${b.batchNo}</span></td>
          <td><strong>${b.quantity}</strong> units</td>
          <td><span style="font-family: var(--font-mono);">${b.expiryDate}</span></td>
          <td><span class="risk-pill ${risk.class}">${risk.label}</span></td>
          <td>${fefoBadge}</td>
          <td><strong>₹${atRiskVal.toLocaleString('en-IN')}</strong></td>
          <td>
            <button type="button" class="btn-secondary" style="height: 28px; font-size: 0.75rem; padding: 0 0.5rem;" onclick="window.quickReturn('${b.id}')">
              Return Claim
            </button>
          </td>
        </tr>
      `;
    }).join('');
  };

  const renderActivityList = () => {
    const list = document.getElementById('activityTimelineList');
    if (!list) return;

    if (pharmacyDb.activity.length === 0) {
      list.innerHTML = `
        <div class="empty-state-small">
          <p>No activity yet.</p>
          <span>Your inventory activity will appear here once you start adding stock.</span>
        </div>
      `;
      return;
    }

    list.innerHTML = pharmacyDb.activity.slice(0, 5).map(act => `
      <div style="display:flex; gap:0.5rem; font-size:0.8125rem; padding:0.4rem 0; border-bottom:1px solid #f1f5f9;">
        <span style="color:var(--brand-primary); font-weight:800;">•</span>
        <div style="flex:1;">
          <div>${act.text}</div>
          <div style="font-size:0.6875rem; color:var(--color-text-muted);">${act.timestamp}</div>
        </div>
      </div>
    `).join('');
  };

  const renderForecastBars = (batches) => {
    const container = document.getElementById('forecastBarsContainer');
    if (!container) return;

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const now = new Date();
    const months = [];

    for (let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      months.push({
        label: `${monthNames[d.getMonth()]} ${d.getFullYear().toString().slice(-2)}`,
        year: d.getFullYear(),
        month: d.getMonth(),
        value: 0,
        count: 0
      });
    }

    batches.forEach(b => {
      if (!b.expiryDate) return;
      const parts = b.expiryDate.split('-');
      if (parts.length >= 2) {
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        const target = months.find(item => item.year === y && item.month === m);
        if (target) {
          target.value += (b.quantity * b.purchaseRate);
          target.count++;
        }
      }
    });

    const maxVal = Math.max(1, ...months.map(m => m.value));

    container.innerHTML = months.map(m => {
      const pct = Math.max(8, Math.round((m.value / maxVal) * 100));
      return `
        <div style="display:flex; flex-direction:column; gap:0.2rem; margin-bottom:0.65rem;">
          <div style="display:flex; justify-content:space-between; font-size:0.75rem;">
            <span style="font-weight:700;">${m.label}</span>
            <span style="font-family:var(--font-mono); color:var(--color-text-secondary);">₹${m.value.toLocaleString('en-IN')} (${m.count} batches)</span>
          </div>
          <div style="height:6px; background:#f1f5f9; border-radius:var(--radius-pill); overflow:hidden;">
            <div style="width:${m.value > 0 ? pct : 0}%; height:100%; background:linear-gradient(90deg, #059669 0%, #0d9488 100%); border-radius:var(--radius-pill);"></div>
          </div>
        </div>
      `;
    }).join('');
  };

  const renderInventoryTable = () => {
    const tbody = document.getElementById('inventoryTableBody');
    const empty = document.getElementById('emptyInventoryTableState');
    const searchInput = document.getElementById('inventorySearchInput');
    const filterSelect = document.getElementById('inventoryExpiryFilter');

    if (!tbody || !empty) return;

    const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
    const filter = filterSelect ? filterSelect.value : 'all';

    let batches = pharmacyDb.batches.map(b => ({
      ...b,
      daysLeft: calculateDaysRemaining(b.expiryDate)
    }));

    if (query) {
      batches = batches.filter(b => 
        b.name.toLowerCase().includes(query) ||
        b.batchNo.toLowerCase().includes(query) ||
        (b.distributor && b.distributor.toLowerCase().includes(query))
      );
    }

    if (filter !== 'all') {
      batches = batches.filter(b => {
        if (filter === 'critical') return b.daysLeft <= 30;
        if (filter === 'warning') return b.daysLeft > 30 && b.daysLeft <= 60;
        if (filter === 'watchlist') return b.daysLeft > 60 && b.daysLeft <= 90;
        if (filter === 'safe') return b.daysLeft > 90;
        return true;
      });
    }

    if (batches.length === 0) {
      tbody.innerHTML = '';
      empty.hidden = false;
      return;
    }

    empty.hidden = true;

    tbody.innerHTML = batches.map(b => {
      const risk = getRiskDetails(b.daysLeft);
      const totalVal = b.quantity * b.purchaseRate;

      return `
        <tr>
          <td>
            <strong>${b.name}</strong>
            <div style="font-size: 0.725rem; color: var(--color-text-muted);">${b.pack || 'Standard'}</div>
          </td>
          <td><span class="table-batch-pill">${b.batchNo}</span></td>
          <td><span style="font-size: 0.75rem; color: var(--color-text-muted);">${b.rack || 'Rack A-1'}</span></td>
          <td><strong>${b.quantity}</strong> units</td>
          <td><span style="font-family: var(--font-mono);">${b.expiryDate}</span></td>
          <td><span class="risk-pill ${risk.class}">${risk.label}</span></td>
          <td><span class="fefo-pill">FIFO Active</span></td>
          <td><span style="font-family: var(--font-mono);">₹${b.purchaseRate.toLocaleString('en-IN')}</span></td>
          <td><strong>₹${totalVal.toLocaleString('en-IN')}</strong></td>
          <td>
            <button type="button" class="btn-secondary" style="height: 28px; font-size: 0.75rem; padding: 0 0.5rem;" onclick="window.quickReturn('${b.id}')">
              Return
            </button>
          </td>
        </tr>
      `;
    }).join('');
  };

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

    tbody.innerHTML = pharmacyDb.batches.map(b => {
      const days = calculateDaysRemaining(b.expiryDate);
      const risk = getRiskDetails(days);
      const totalVal = b.quantity * b.purchaseRate;

      return `
        <tr>
          <td><strong>${b.name}</strong></td>
          <td><span class="table-batch-pill">${b.batchNo}</span></td>
          <td><strong>${b.quantity}</strong> units</td>
          <td><span style="font-family: var(--font-mono);">${b.expiryDate}</span></td>
          <td><span class="risk-pill ${risk.class}">${risk.label}</span></td>
          <td><span class="fefo-pill">Priority 1</span></td>
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

<<<<<<< HEAD
    // 1. Aggregate stock across batches and resolve demand tier
=======
>>>>>>> 8328e7a6a60184d811dac1cafd69311e92dd1546
    const medTotals = {};
    pharmacyDb.batches.forEach(b => {
<<<<<<< HEAD
      const k = b.name.trim();
      medTotals[k] = (medTotals[k] || 0) + (Number(b.quantity) || 0);

      // Resolve tier: if already saved and not AUTO, use it; otherwise auto-detect from name
      if (!medTiers[k] || medTiers[k] === 'AUTO') {
        if (b.demandTier && b.demandTier !== 'AUTO') {
          medTiers[k] = b.demandTier;
        } else if (window.InventoryRules) {
          medTiers[k] = window.InventoryRules.inferDemandTier(k);
        }
      }
    });

    // 2. Evaluate each medicine against its tier threshold
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
=======
      const k = b.name;
      medTotals[k] = (medTotals[k] || 0) + b.quantity;
    });

    const lowStockMeds = Object.keys(medTotals).filter(name => medTotals[name] > 0 && medTotals[name] < 15);
>>>>>>> 8328e7a6a60184d811dac1cafd69311e92dd1546

    if (sideCountLowStock) {
      sideCountLowStock.textContent = lowStockMeds.length;
      sideCountLowStock.hidden = lowStockMeds.length === 0;
    }

    if (lowStockMeds.length === 0) {
      list.hidden = true;
      empty.hidden = false;
      return;
    }

    empty.hidden = true;
    list.hidden = false;
<<<<<<< HEAD
    lowStockItems.sort((a, b) => b.deficit - a.deficit);

    list.innerHTML = lowStockItems.map(item => `
=======

    list.innerHTML = lowStockMeds.map(med => `
>>>>>>> 8328e7a6a60184d811dac1cafd69311e92dd1546
      <div style="display:flex; align-items:center; justify-content:space-between; padding:0.85rem 1rem; background:#fff; border:1px solid var(--color-border); border-radius:var(--radius-md); margin-bottom:0.65rem;">
        <div>
          <strong>${med}</strong>
          <div style="font-size:0.75rem; color:var(--status-warning); font-weight:700;">Stock: ${medTotals[med]} units (Threshold: 15)</div>
        </div>
<<<<<<< HEAD
        <button type="button" class="btn-primary" style="height:32px; font-size:0.75rem;" onclick="alert('Reorder reminder set for ${item.name} (+${item.deficit} units)')">
=======
        <button type="button" class="btn-primary" style="height:32px; font-size:0.75rem;" onclick="alert('Reorder reminder created for ${med}')">
>>>>>>> 8328e7a6a60184d811dac1cafd69311e92dd1546
          Create Reorder Reminder
        </button>
      </div>
    `).join('');
  };

  // ==========================================================================
  // FEATURE 1: NOTIFICATIONS SYSTEM ENGINE
  // ==========================================================================

  const getNotifIconAndClass = (type) => {
    const t = (type || '').toLowerCase();
    if (t.includes('bill')) return { icon: '🧾', class: 'bill', title: 'New Bill Added' };
    if (t.includes('sold')) return { icon: '🏷️', class: 'sold', title: 'Stock Sold' };
    if (t.includes('expiry')) return { icon: '⏱️', class: 'expiry', title: 'Expiry Alert' };
    if (t.includes('stock') || t.includes('low')) return { icon: '⚠️', class: 'expiry', title: 'Low Stock' };
    return { icon: '🔔', class: 'system', title: 'System Notification' };
  };

  const updateNotificationBadges = () => {
    const notifBadge = document.getElementById('notifBadge');
    const dropdownUnread = document.getElementById('notifDropdownUnreadCount');
    const unread = pharmacyDb.notifications.filter(n => !n.read).length;

    if (notifBadge) {
      notifBadge.textContent = unread;
      notifBadge.hidden = unread === 0;
    }
    if (dropdownUnread) {
      dropdownUnread.textContent = `${unread} new`;
      dropdownUnread.hidden = unread === 0;
    }
  };

  const fetchNotifications = async () => {
    if (!currentPharmacy || !currentPharmacy.id || isDemoMode) return;
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/api/notifications`);
      if (res.ok) {
        const data = await res.json();
        if (data.notifications) {
          pharmacyDb.notifications = data.notifications.map(n => ({
            id: n.id,
            text: n.text,
            type: (n.type || 'system').toLowerCase(),
            read: Boolean(n.is_read),
            timestamp: n.created_at ? formatTimeAgo(n.created_at) : 'Recent',
            createdAt: n.created_at
          }));
          updateNotificationBadges();
          renderNotificationsView();
          renderNotificationsDropdown();
        }
      }
    } catch (e) {
      console.warn('Could not fetch notifications:', e);
    }
  };

  const renderNotificationsDropdown = () => {
    const list = document.getElementById('notifDropdownList');
    if (!list) return;

    if (pharmacyDb.notifications.length === 0) {
      list.innerHTML = `
        <div class="empty-state-small" style="padding:1.5rem 1rem;">
          <p style="font-size:0.8125rem; font-weight:600; margin-bottom:0.25rem;">No notifications yet</p>
          <span style="font-size:0.725rem; color:var(--color-text-muted);">Real alerts will appear here when bills are added or stock is sold.</span>
        </div>
      `;
      return;
    }

    list.innerHTML = pharmacyDb.notifications.slice(0, 8).map(n => {
      const meta = getNotifIconAndClass(n.type);
      return `
        <div class="notif-card-item ${n.read ? '' : 'unread'}" data-id="${n.id}">
          <div class="notif-type-icon ${meta.class}">${meta.icon}</div>
          <div class="notif-content-box">
            <div class="notif-title-row">
              <div class="notif-text">${n.text}</div>
              ${!n.read ? `<button type="button" class="btn-mark-read-item" onclick="window.markNotificationRead('${n.id}', event)">Mark read</button>` : ''}
            </div>
            <div class="notif-time">${n.timestamp}</div>
          </div>
        </div>
      `;
    }).join('');
  };

  const renderNotificationsView = () => {
    const feed = document.getElementById('notificationsFeed');
    const empty = document.getElementById('emptyNotifsState');
    if (!feed || !empty) return;

    if (pharmacyDb.notifications.length === 0) {
      feed.hidden = true;
      empty.hidden = false;
      return;
    }

    empty.hidden = true;
    feed.hidden = false;

    feed.innerHTML = pharmacyDb.notifications.map(n => {
      const meta = getNotifIconAndClass(n.type);
      return `
        <div class="notif-card-item ${n.read ? '' : 'unread'}" style="border-radius:var(--radius-md); border:1px solid var(--color-border); margin-bottom:0.65rem;" data-id="${n.id}">
          <div class="notif-type-icon ${meta.class}">${meta.icon}</div>
          <div class="notif-content-box">
            <div class="notif-title-row">
              <div>
                <strong style="font-size:0.875rem; color:var(--color-text-main); display:block; margin-bottom:0.15rem;">${meta.title}</strong>
                <div class="notif-text">${n.text}</div>
              </div>
              ${!n.read ? `<button type="button" class="btn-mark-read-item" onclick="window.markNotificationRead('${n.id}', event)">Mark read</button>` : '<span style="font-size:0.6875rem; color:var(--color-text-muted);">Read</span>'}
            </div>
            <div class="notif-time">${n.timestamp}</div>
          </div>
        </div>
      `;
    }).join('');
  };

  window.markNotificationRead = async (notifId, e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    try {
      await authenticatedFetch(`${API_BASE_URL}/api/notifications/read`, {
        method: 'POST',
        body: JSON.stringify({ id: notifId })
      });
    } catch {}
    const notif = pharmacyDb.notifications.find(n => n.id === notifId);
    if (notif) notif.read = true;
    savePharmacyData();
    updateNotificationBadges();
    renderNotificationsDropdown();
    renderNotificationsView();
  };

  window.markAllNotificationsRead = async () => {
    try {
      await authenticatedFetch(`${API_BASE_URL}/api/notifications/read`, {
        method: 'POST',
        body: JSON.stringify({ all: true })
      });
    } catch {}
    pharmacyDb.notifications.forEach(n => { n.read = true; });
    savePharmacyData();
    updateNotificationBadges();
    renderNotificationsDropdown();
    renderNotificationsView();
    showAppToast('Notifications Updated', 'All notifications marked as read.');
  };

  // ==========================================================================
  // FEATURE 2: STOCK CLEARANCE & SOLD ENGINE
  // ==========================================================================

  const renderReturnsView = () => {
    // 1. Priority Stock Clearance Table (Near Expiry <= 90 days)
    const clearanceWrapper = document.getElementById('clearanceTableWrapper');
    const clearanceBody = document.getElementById('clearanceTableBody');
    const emptyClearance = document.getElementById('emptyClearanceState');

    const nearExpiryBatches = pharmacyDb.batches
      .filter(b => b.quantity > 0 && calculateDaysRemaining(b.expiryDate) <= 90)
      .sort((a, b) => calculateDaysRemaining(a.expiryDate) - calculateDaysRemaining(b.expiryDate));

    if (clearanceWrapper && clearanceBody && emptyClearance) {
      if (nearExpiryBatches.length === 0) {
        clearanceWrapper.hidden = true;
        emptyClearance.hidden = false;
      } else {
        emptyClearance.hidden = true;
        clearanceWrapper.hidden = false;
        clearanceBody.innerHTML = nearExpiryBatches.map(b => {
          const days = calculateDaysRemaining(b.expiryDate);
          const risk = getRiskDetails(days);
          const rateOrMrp = b.mrp || b.purchaseRate || 0;
          return `
            <tr>
              <td><strong>${b.name}</strong></td>
              <td><span class="table-batch-pill">${b.batchNo}</span></td>
              <td><span style="font-family:var(--font-mono); font-size:0.8125rem;">${b.expiryDate}</span></td>
              <td><span class="risk-pill ${risk.class}">${risk.label}</span></td>
              <td><strong>${b.quantity}</strong> units</td>
              <td><strong>₹${rateOrMrp.toLocaleString('en-IN')}</strong></td>
              <td style="text-align:right;">
                <button type="button" class="btn-sold-clearance" onclick="window.openSoldModal('${b.id}')">
                  <span>🏷️ SOLD</span>
                </button>
              </td>
            </tr>
          `;
        }).join('');
      }
    }

    // 2. Distributor Return Claims (<= 60 days grouped by stockist)
    const grid = document.getElementById('returnsCardsGrid');
    const emptyReturns = document.getElementById('emptyReturnsState');
    if (!grid || !emptyReturns) return;

    const returnBatches = pharmacyDb.batches.filter(b => b.quantity > 0 && calculateDaysRemaining(b.expiryDate) <= 60);

    if (returnBatches.length === 0) {
      grid.hidden = true;
      emptyReturns.hidden = false;
      return;
    }

    emptyReturns.hidden = true;
    grid.hidden = false;

    const distGroups = {};
    returnBatches.forEach(b => {
      const dist = b.distributor || 'General Stockist';
      if (!distGroups[dist]) distGroups[dist] = [];
      distGroups[dist].push(b);
    });

    grid.innerHTML = Object.keys(distGroups).map(dist => {
      const items = distGroups[dist];
      const claimVal = items.reduce((sum, i) => sum + (i.quantity * i.purchaseRate), 0);

      return `
        <div class="dash-card gradient-border-subtle" style="margin-bottom: 1rem;">
          <div class="dash-card-header">
            <div>
              <strong>${dist}</strong>
              <div style="font-size: 0.75rem; color: var(--color-text-muted);">${items.length} expiring batches eligible for debit note return</div>
            </div>
            <strong style="font-family: var(--font-mono); color: var(--status-critical); font-size: 1.1rem;">Claim: ₹${claimVal.toLocaleString('en-IN')}</strong>
          </div>
          <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.5rem;">
            ${items.map(i => `
              <div style="display:inline-flex; align-items:center; gap:0.4rem; background:#fff; border:1px solid var(--color-border); border-radius:var(--radius-sm); padding:0.25rem 0.5rem; font-size:0.75rem;">
                <span>${i.name} (${i.batchNo}) — <strong>${i.quantity} units</strong></span>
                <button type="button" class="btn-sold-clearance" style="padding:0.2rem 0.45rem; font-size:0.6875rem;" onclick="window.openSoldModal('${i.id}')">SOLD</button>
              </div>
            `).join('')}
          </div>
          <div style="margin-top: 0.75rem; display: flex; justify-content: flex-end;">
            <button type="button" class="btn-primary" style="height: 34px; font-size: 0.8125rem;" onclick="window.generateDebitNote('${dist}')">
              Generate Return Debit Note
            </button>
          </div>
        </div>
      `;
    }).join('');
  };

  window.generateDebitNote = (dist) => {
    alert(`Official Return Debit Note Generated for ${dist}. Hand copy to distributor rep for 100% credit adjustment.`);
  };

  window.quickReturn = (batchId) => {
    switchWorkspaceTab('returns');
  };

  // Stock Clearance SOLD Modal Handlers
  let activeSoldBatch = null;

  window.openSoldModal = (batchId) => {
    const batch = pharmacyDb.batches.find(b => b.id === batchId);
    if (!batch || batch.quantity <= 0) {
      alert('Selected batch is not available in active stock.');
      return;
    }

    activeSoldBatch = batch;
    const modal = document.getElementById('soldStockModal');
    if (!modal) return;

    document.getElementById('soldModalBatchId').value = batch.id;
    document.getElementById('soldModalMedName').textContent = batch.name;
    document.getElementById('soldModalBatchNo').textContent = batch.batchNo;
    
    const days = calculateDaysRemaining(batch.expiryDate);
    const risk = getRiskDetails(days);
    const pill = document.getElementById('soldModalExpiryPill');
    if (pill) {
      pill.textContent = risk.label;
      pill.className = `risk-pill ${risk.class}`;
    }

    document.getElementById('soldModalAvailableQty').textContent = `${batch.quantity} units`;
    document.getElementById('soldModalMaxQtyText').textContent = batch.quantity;
    
    const rate = batch.mrp || batch.purchaseRate || 0;
    document.getElementById('soldModalRateVal').textContent = `₹${rate.toLocaleString('en-IN')}`;

    const qtyInput = document.getElementById('soldModalQtyInput');
    qtyInput.max = batch.quantity;
    qtyInput.value = Math.min(1, batch.quantity);

    const calcVal = parseFloat(qtyInput.value) * rate;
    document.getElementById('soldModalTotalValue').textContent = `₹${calcVal.toLocaleString('en-IN')}`;
    document.getElementById('soldModalNotes').value = '';

    modal.classList.remove('view-hidden');
  };

<<<<<<< HEAD
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
=======
  const closeSoldModal = () => {
    const modal = document.getElementById('soldStockModal');
    if (modal) modal.classList.add('view-hidden');
    activeSoldBatch = null;
>>>>>>> 8328e7a6a60184d811dac1cafd69311e92dd1546
  };

  const updateSoldModalValue = () => {
    if (!activeSoldBatch) return;
    const qtyInput = document.getElementById('soldModalQtyInput');
    const totalValEl = document.getElementById('soldModalTotalValue');
    let val = parseFloat(qtyInput.value) || 0;
    if (val < 1) val = 1;
    if (val > activeSoldBatch.quantity) val = activeSoldBatch.quantity;
    qtyInput.value = val;

    const rate = activeSoldBatch.mrp || activeSoldBatch.purchaseRate || 0;
    const total = val * rate;
    if (totalValEl) totalValEl.textContent = `₹${total.toLocaleString('en-IN')}`;
  };

  const soldQtyInput = document.getElementById('soldModalQtyInput');
  if (soldQtyInput) {
    soldQtyInput.addEventListener('input', updateSoldModalValue);
    soldQtyInput.addEventListener('change', updateSoldModalValue);
  }

  // Quick qty pills
  document.querySelectorAll('.btn-quick-qty').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!activeSoldBatch) return;
      const type = btn.getAttribute('data-qty');
      const qtyInput = document.getElementById('soldModalQtyInput');
      if (type === '1') qtyInput.value = 1;
      else if (type === '5') qtyInput.value = Math.min(5, activeSoldBatch.quantity);
      else if (type === 'half') qtyInput.value = Math.max(1, Math.floor(activeSoldBatch.quantity / 2));
      else if (type === 'all') qtyInput.value = activeSoldBatch.quantity;
      updateSoldModalValue();
    });
  });

  const closeSoldModalBtn = document.getElementById('closeSoldModalBtn');
  const cancelSoldBtn = document.getElementById('cancelSoldBtn');
  const soldStockBackdrop = document.getElementById('soldStockBackdrop');

  if (closeSoldModalBtn) closeSoldModalBtn.addEventListener('click', closeSoldModal);
  if (cancelSoldBtn) cancelSoldBtn.addEventListener('click', closeSoldModal);
  if (soldStockBackdrop) soldStockBackdrop.addEventListener('click', closeSoldModal);

  const soldStockForm = document.getElementById('soldStockForm');
  if (soldStockForm) {
    soldStockForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!activeSoldBatch) return;

      const batchId = document.getElementById('soldModalBatchId').value;
      const qty = parseFloat(document.getElementById('soldModalQtyInput').value) || 0;
      const notes = document.getElementById('soldModalNotes').value;

      if (qty <= 0 || qty > activeSoldBatch.quantity) {
        alert(`Please enter a valid quantity between 1 and ${activeSoldBatch.quantity}.`);
        return;
      }

      const confirmBtn = document.getElementById('confirmSoldBtn');
      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Recording Sale…';
      }

      try {
        const res = await authenticatedFetch(`${API_BASE_URL}/api/inventory/sell`, {
          method: 'POST',
          body: JSON.stringify({
            batch_id: batchId,
            quantity: qty,
            notes: notes
          })
        });
        const data = await res.json();

        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.innerHTML = '<span>🏷️ Mark as Sold</span>';
        }

        if (!res.ok) {
          alert(data.error || 'Failed to record stock sale.');
          return;
        }

        // Update local state
        const remaining = data.remaining_quantity !== undefined ? data.remaining_quantity : (activeSoldBatch.quantity - qty);
        activeSoldBatch.quantity = remaining;

        if (remaining <= 0) {
          // Remove from active inventory
          pharmacyDb.batches = pharmacyDb.batches.filter(b => b.id !== batchId);
        }

        // Log movement locally
        const rate = activeSoldBatch.mrp || activeSoldBatch.purchaseRate || 0;
        pharmacyDb.movements.unshift({
          id: data.movement_id || ('MOV_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36)),
          type: 'Sold',
          medicineName: activeSoldBatch.name,
          batchNo: activeSoldBatch.batchNo,
          quantity: qty,
          value: qty * rate,
          notes: notes || `Stock Clearance Sale (Batch: ${activeSoldBatch.batchNo})`,
          timestamp: 'Just now'
        });

        savePharmacyData();
        await fetchNotifications();
        refreshAllWorkspaceViews();
        closeSoldModal();

        showAppToast('Stock Sold Successfully', data.message || `${qty} units of ${activeSoldBatch.name} marked as sold.`);
      } catch (err) {
        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.innerHTML = '<span>🏷️ Mark as Sold</span>';
        }
        alert('Network error while recording stock sale. Please try again.');
      }
    });
  }

  // ==========================================================================
  // FEATURE 3: COMPLETE PROFILE & PHOTO MANAGEMENT ENGINE
  // ==========================================================================

  window.openProfileModal = async () => {
    const modal = document.getElementById('profileModal');
    if (!modal || !currentPharmacy) return;

    // Fetch latest user record from backend
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/api/profile`);
      if (res.ok) {
        const data = await res.json();
        if (data.user) {
          currentPharmacy = data.user;
          sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(currentPharmacy));
        }
      }
    } catch {}

    const oName = currentPharmacy.owner_name || currentPharmacy.ownerName || 'Pharmacy Owner';
    const email = currentPharmacy.email || '';
    const mobile = currentPharmacy.mobile || 'Not provided';
    const shopName = currentPharmacy.shop_name || currentPharmacy.shopName || 'My Pharmacy';
    const dlNumber = currentPharmacy.dl_number || currentPharmacy.dlNumber || 'Not provided';
    const pType = currentPharmacy.pharmacy_type || currentPharmacy.pharmacyType || 'Retail Pharmacy';
    const sAddr = currentPharmacy.shop_address || currentPharmacy.shopAddress || '';
    const city = currentPharmacy.city || '';
    const state = currentPharmacy.state || '';
    const pin = currentPharmacy.pincode || '';
    const photo = currentPharmacy.profile_photo || null;

    // Render avatar
    const avatarEl = document.getElementById('profileModalAvatar');
    if (avatarEl) {
      if (photo) {
        avatarEl.innerHTML = `<img src="${photo}" alt="${oName}">`;
      } else {
        const initials = oName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
        avatarEl.textContent = initials || 'PH';
      }
    }

    const ownerNameEl = document.getElementById('profileModalOwnerName');
    const emailEl = document.getElementById('profileModalEmail');
    const mobileEl = document.getElementById('profileModalMobile');
    const typeBadgeEl = document.getElementById('profileModalTypeBadge');
    const shopNameEl = document.getElementById('profileModalShopName');
    const dlNumberEl = document.getElementById('profileModalDlNumber');
    const pTypeEl = document.getElementById('profileModalPharmacyType');
    const addrEl = document.getElementById('profileModalAddress');
    const cityStateEl = document.getElementById('profileModalCityState');

    if (ownerNameEl) ownerNameEl.textContent = oName;
    if (emailEl) emailEl.textContent = email;
    if (mobileEl) mobileEl.textContent = mobile;
    if (typeBadgeEl) typeBadgeEl.textContent = pType;
    if (shopNameEl) shopNameEl.textContent = shopName;
    if (dlNumberEl) dlNumberEl.textContent = dlNumber;
    if (pTypeEl) pTypeEl.textContent = pType;
    if (addrEl) addrEl.textContent = sAddr || 'Not provided';
    if (cityStateEl) cityStateEl.textContent = [city, state, pin].filter(Boolean).join(', ') || 'Not provided';

    // Populate edit form inputs
    const editOwner = document.getElementById('editOwnerName');
    const editMob = document.getElementById('editMobile');
    const editShop = document.getElementById('editShopName');
    const editDl = document.getElementById('editDlNumber');
    const editAddr = document.getElementById('editShopAddress');
    const editCityEl = document.getElementById('editCity');
    const editStateEl = document.getElementById('editState');
    const editPinEl = document.getElementById('editPincode');
    const editPType = document.getElementById('editPharmacyType');

    if (editOwner) editOwner.value = oName;
    if (editMob) editMob.value = mobile !== 'Not provided' ? mobile : '';
    if (editShop) editShop.value = shopName !== 'My Pharmacy' ? shopName : '';
    if (editDl) editDl.value = dlNumber !== 'Not provided' ? dlNumber : '';
    if (editAddr) editAddr.value = sAddr;
    if (editCityEl) editCityEl.value = city;
    if (editStateEl) editStateEl.value = state;
    if (editPinEl) editPinEl.value = pin;
    if (editPType) editPType.value = pType;

    // Reset to view mode
    const viewMode = document.getElementById('profileViewMode');
    const editForm = document.getElementById('profileEditForm');
    if (viewMode) viewMode.classList.remove('view-hidden');
    if (editForm) editForm.classList.add('view-hidden');

    modal.classList.remove('view-hidden');
  };

  const closeProfileModal = () => {
    const modal = document.getElementById('profileModal');
    if (modal) modal.classList.add('view-hidden');
  };

  const closeProfileModalBtn = document.getElementById('closeProfileModalBtn');
  const profileModalBackdrop = document.getElementById('profileModalBackdrop');
  if (closeProfileModalBtn) closeProfileModalBtn.addEventListener('click', closeProfileModal);
  if (profileModalBackdrop) profileModalBackdrop.addEventListener('click', closeProfileModal);

  // Toggle edit form in profile modal
  const toggleEditProfileBtn = document.getElementById('toggleEditProfileBtn');
  const cancelEditProfileBtn = document.getElementById('cancelEditProfileBtn');
  const profileViewMode = document.getElementById('profileViewMode');
  const profileEditForm = document.getElementById('profileEditForm');

  if (toggleEditProfileBtn) {
    toggleEditProfileBtn.addEventListener('click', () => {
      if (profileViewMode) profileViewMode.classList.add('view-hidden');
      if (profileEditForm) profileEditForm.classList.remove('view-hidden');
    });
  }

  if (cancelEditProfileBtn) {
    cancelEditProfileBtn.addEventListener('click', () => {
      if (profileEditForm) profileEditForm.classList.add('view-hidden');
      if (profileViewMode) profileViewMode.classList.remove('view-hidden');
    });
  }

  // Save profile changes
  if (profileEditForm) {
    profileEditForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const saveBtn = document.getElementById('saveProfileBtn');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
      }

      const payload = {
        owner_name: document.getElementById('editOwnerName').value.trim(),
        mobile: document.getElementById('editMobile').value.trim(),
        shop_name: document.getElementById('editShopName').value.trim(),
        dl_number: document.getElementById('editDlNumber').value.trim(),
        shop_address: document.getElementById('editShopAddress').value.trim(),
        city: document.getElementById('editCity').value.trim(),
        state: document.getElementById('editState').value.trim(),
        pincode: document.getElementById('editPincode').value.trim(),
        pharmacy_type: document.getElementById('editPharmacyType').value
      };

      try {
        const res = await authenticatedFetch(`${API_BASE_URL}/api/profile/update`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Profile';
        }

        if (!res.ok) {
          alert(data.error || 'Failed to update profile.');
          return;
        }

        currentPharmacy = data.user;
        sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(currentPharmacy));
        localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(currentPharmacy));

        refreshAllWorkspaceViews();
        window.openProfileModal(); // re-render view mode with fresh data
        showAppToast('Profile Updated', 'Your pharmacy profile details have been saved.');
      } catch (err) {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Profile';
        }
        alert('Network error while saving profile details.');
      }
    });
  }

  // Profile Photo Upload Handlers
  const profilePhotoTriggerBtn = document.getElementById('profilePhotoTriggerBtn');
  const profilePhotoChangeBtn = document.getElementById('profilePhotoChangeBtn');
  const profilePhotoFileInput = document.getElementById('profilePhotoFileInput');

  const triggerPhotoUpload = () => {
    if (profilePhotoFileInput) profilePhotoFileInput.click();
  };

  if (profilePhotoTriggerBtn) profilePhotoTriggerBtn.addEventListener('click', triggerPhotoUpload);
  if (profilePhotoChangeBtn) profilePhotoChangeBtn.addEventListener('click', triggerPhotoUpload);

  if (profilePhotoFileInput) {
    profilePhotoFileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        handleProfilePhotoUpload(file);
      }
      e.target.value = ''; // reset file input
    });
  }

  const handleProfilePhotoUpload = (file) => {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/jpg'].includes(file.type)) {
      alert('Please select a valid image file (JPEG, PNG, or WEBP).');
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      alert('Image file too large. Maximum size is 3MB.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (re) => {
      const img = new Image();
      img.onload = async () => {
        const canvas = document.createElement('canvas');
        const MAX_DIM = 400;
        let w = img.width;
        let h = img.height;
        if (w > h) {
          if (w > MAX_DIM) {
            h *= MAX_DIM / w;
            w = MAX_DIM;
          }
        } else {
          if (h > MAX_DIM) {
            w *= MAX_DIM / h;
            h = MAX_DIM;
          }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const compressedBase64 = canvas.toDataURL('image/jpeg', 0.85);

        try {
          const res = await authenticatedFetch(`${API_BASE_URL}/api/profile/photo`, {
            method: 'POST',
            body: JSON.stringify({ photo: compressedBase64 })
          });
          const data = await res.json();
          if (res.ok && data.user) {
            currentPharmacy = data.user;
            sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(currentPharmacy));
            localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(currentPharmacy));

            // Update avatars
            const avatarModal = document.getElementById('profileModalAvatar');
            if (avatarModal) avatarModal.innerHTML = `<img src="${compressedBase64}" alt="Profile">`;
            const avatarTop = document.getElementById('userAvatarInitials');
            if (avatarTop) avatarTop.innerHTML = `<img src="${compressedBase64}" alt="Profile">`;

            showAppToast('Profile Photo Saved', 'Your new avatar has been updated.');
          } else {
            alert(data.error || 'Failed to save profile photo.');
          }
        } catch (err) {
          alert('Network error while saving profile photo.');
        }
      };
      img.src = re.target.result;
    };
    reader.readAsDataURL(file);
  };

  // Sign out handler
  const performSignOut = async () => {
    if (!confirm('Are you sure you want to sign out of your pharmacy workspace?')) return;
    try {
      if (window.firebaseAuth && typeof window.firebaseAuth.signOut === 'function') {
        await window.firebaseAuth.signOut();
      }
    } catch {}

    try {
      await fetch(`${API_BASE_URL}/api/auth/logout`, {
        method: 'POST',
        headers: getAuthHeaders(),
        credentials: 'omit'
      });
    } catch {}

    sessionStorage.removeItem(ACTIVE_SESSION_KEY);
    localStorage.removeItem(ACTIVE_SESSION_KEY);
    sessionStorage.removeItem(ACTIVE_TOKEN_KEY);
    localStorage.removeItem(ACTIVE_TOKEN_KEY);
    sessionToken = null;
    currentPharmacy = null;
    pharmacyDb = { batches: [], bills: [], movements: [], expenses: [], notifications: [], activity: [] };

    closeProfileModal();
    showScreen('welcome');
  };

  const logoutBtn = document.getElementById('logoutBtn');
  const profileModalSignOutBtn = document.getElementById('profileModalSignOutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', performSignOut);
  if (profileModalSignOutBtn) profileModalSignOutBtn.addEventListener('click', performSignOut);

  const getBillDocumentUrl = (bill, isDownload = false) => {
    if (!bill) return '';
    const billId = typeof bill === 'string' ? bill : (bill.id || bill.bill_id);
    if (!billId) return '';
    let base = API_BASE_URL ? `${API_BASE_URL}/api/bills/${billId}/document` : `/api/bills/${billId}/document`;
    const params = [];
    if (sessionToken) {
      params.push(`token=${encodeURIComponent(sessionToken)}`);
    }
    if (isDownload) {
      params.push('download=1');
    }
    return params.length > 0 ? `${base}?${params.join('&')}` : base;
  };

  const renderBillsHistory = () => {
    const list = document.getElementById('billsHistoryList');
    const empty = document.getElementById('emptyBillsHistory');
    if (!list || !empty) return;

    if (pharmacyDb.bills.length === 0) {
      list.hidden = true;
      empty.hidden = false;
      return;
    }

    empty.hidden = true;
    list.hidden = false;

    list.innerHTML = pharmacyDb.bills.map(bill => {
      const docUrl = getBillDocumentUrl(bill);
      return `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.85rem 1rem; background: #ffffff; border: 1px solid var(--color-border); border-radius: var(--radius-md); margin-bottom: 0.65rem;">
        <div style="display: flex; align-items: center; gap: 0.75rem;">
          <div style="width: 36px; height: 36px; border-radius: var(--radius-sm); background: #ecfdf5; color: #059669; display: flex; align-items: center; justify-content: center; font-size: 1.1rem;">📄</div>
          <div>
            <strong>${bill.distributor}</strong>
            <div style="font-size: 0.75rem; color: var(--color-text-muted);">Invoice #${bill.invoiceNo} • ${bill.date}</div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:1rem;">
          <div style="text-align: right;">
            <strong style="font-family: var(--font-mono); font-size: 0.95rem;">₹${(bill.totalAmount || 0).toLocaleString('en-IN')}</strong>
            <div style="font-size: 0.75rem; color: #059669; font-weight: 600;">${bill.itemsCount} medicines added</div>
          </div>
          ${docUrl ? `<a href="${docUrl}" target="_blank" class="btn-secondary" style="height:28px; font-size:0.75rem; padding:0 0.5rem;">View Original ↗</a>` : ''}
        </div>
      </div>
    `;
    }).join('');
  };

  // ==========================================================================
  // 7B. DEDICATED BILL HISTORY ARCHIVE & MULTI-FIELD SEARCH ENGINE
  // ==========================================================================
  const billHistoryGrid = document.getElementById('billHistoryGrid');
  const billHistoryEmptyState = document.getElementById('billHistoryEmptyState');
  const billHistoryNoResultsState = document.getElementById('billHistoryNoResultsState');
  const billHistorySearchInput = document.getElementById('billHistorySearchInput');
  const billHistoryClearSearchBtn = document.getElementById('billHistoryClearSearchBtn');
  const billHistoryDateFilter = document.getElementById('billHistoryDateFilter');
  const billHistorySortFilter = document.getElementById('billHistorySortFilter');
  const billHistoryResultsCount = document.getElementById('billHistoryResultsCount');
  const billHistoryActiveQueryTag = document.getElementById('billHistoryActiveQueryTag');
  const billHistoryActiveQueryText = document.getElementById('billHistoryActiveQueryText');
  const billHistoryRemoveQueryBtn = document.getElementById('billHistoryRemoveQueryBtn');
  const billHistoryResetFiltersBtn = document.getElementById('billHistoryResetFiltersBtn');
  const sideCountBillHistory = document.getElementById('sideCountBillHistory');

  // Bill Detail Modal Elements
  const billDetailModal = document.getElementById('billDetailModal');
  const billDetailModalBackdrop = document.getElementById('billDetailModalBackdrop');
  const backToBillHistoryBtn = document.getElementById('backToBillHistoryBtn');
  const closeBillDetailModalBtn = document.getElementById('closeBillDetailModalBtn');
  const closeBillDetailModalBottomBtn = document.getElementById('closeBillDetailModalBottomBtn');
  const billDetailViewOriginalBtn = document.getElementById('billDetailViewOriginalBtn');
  const billDetailDownloadOriginalBtn = document.getElementById('billDetailDownloadOriginalBtn');
  const billDetailModalTitle = document.getElementById('billDetailModalTitle');
  const billDetailModalSubtitle = document.getElementById('billDetailModalSubtitle');
  const billDetailDistributorName = document.getElementById('billDetailDistributorName');
  const billDetailSellerName = document.getElementById('billDetailSellerName');
  const billDetailSellerNameRow = document.getElementById('billDetailSellerNameRow');
  const billDetailPlace = document.getElementById('billDetailPlace');
  const billDetailAddress = document.getElementById('billDetailAddress');
  const billDetailGstin = document.getElementById('billDetailGstin');
  const billDetailDlNumber = document.getElementById('billDetailDlNumber');
  const billDetailPhone = document.getElementById('billDetailPhone');
  const billDetailId = document.getElementById('billDetailId');
  const billDetailInvoiceNo = document.getElementById('billDetailInvoiceNo');
  const billDetailInvoiceDate = document.getElementById('billDetailInvoiceDate');
  const billDetailItemsCount = document.getElementById('billDetailItemsCount');
  const billDetailTotalAmount = document.getElementById('billDetailTotalAmount');
  const billDetailItemsBadge = document.getElementById('billDetailItemsBadge');
  const billDetailDocFilename = document.getElementById('billDetailDocFilename');
  const billDetailDocImg = document.getElementById('billDetailDocImg');
  const billDetailPdfNotice = document.getElementById('billDetailPdfNotice');
  const billDetailOpenPdfBtn = document.getElementById('billDetailOpenPdfBtn');
  const billDetailNoDocNotice = document.getElementById('billDetailNoDocNotice');
  const toggleDocPreviewBtn = document.getElementById('toggleDocPreviewBtn');
  const billDetailDocPreviewContainer = document.getElementById('billDetailDocPreviewContainer');
  const billDetailItemsTbody = document.getElementById('billDetailItemsTbody');

  const renderBillHistoryView = () => {
    if (!billHistoryGrid) return;

    if (sideCountBillHistory) {
      sideCountBillHistory.textContent = pharmacyDb.bills.length;
      sideCountBillHistory.hidden = pharmacyDb.bills.length === 0;
    }

    if (pharmacyDb.bills.length === 0) {
      billHistoryGrid.innerHTML = '';
      billHistoryGrid.hidden = true;
      if (billHistoryNoResultsState) billHistoryNoResultsState.hidden = true;
      if (billHistoryEmptyState) billHistoryEmptyState.hidden = false;
      if (billHistoryResultsCount) billHistoryResultsCount.textContent = '0 purchase bills recorded';
      if (billHistoryClearSearchBtn) billHistoryClearSearchBtn.hidden = true;
      if (billHistoryActiveQueryTag) billHistoryActiveQueryTag.hidden = true;
      return;
    }

    if (billHistoryEmptyState) billHistoryEmptyState.hidden = true;

    const query = (billHistorySearchInput ? billHistorySearchInput.value : '').trim().toLowerCase();
    
    if (query) {
      if (billHistoryClearSearchBtn) billHistoryClearSearchBtn.hidden = false;
      if (billHistoryActiveQueryTag) {
        billHistoryActiveQueryTag.hidden = false;
        if (billHistoryActiveQueryText) billHistoryActiveQueryText.textContent = query;
      }
    } else {
      if (billHistoryClearSearchBtn) billHistoryClearSearchBtn.hidden = true;
      if (billHistoryActiveQueryTag) billHistoryActiveQueryTag.hidden = true;
    }

    // 1. Multi-Field Comprehensive Search Filtering
    let filtered = pharmacyDb.bills.filter(bill => {
      if (!query) return true;

      // Check distributor name
      if ((bill.distributor || '').toLowerCase().includes(query)) return true;

      // Check seller shop / entity name
      const sName = (bill.sellerName || (bill.seller_data && bill.seller_data.name) || '').toLowerCase();
      if (sName.includes(query)) return true;

      // Check location / place / city / state
      const place = (bill.place || (bill.seller_data && (bill.seller_data.place || bill.seller_data.city || bill.seller_data.state)) || '').toLowerCase();
      if (place.includes(query)) return true;

      // Check address
      const addr = (bill.address || (bill.seller_data && bill.seller_data.address) || '').toLowerCase();
      if (addr.includes(query)) return true;

      // Check invoice number
      if ((bill.invoiceNo || '').toLowerCase().includes(query)) return true;

      // Check GSTIN
      const gstin = (bill.gstin || (bill.seller_data && bill.seller_data.gstin) || '').toLowerCase();
      if (gstin.includes(query)) return true;

      // Check Drug License Number
      const dl = (bill.dlNumber || (bill.seller_data && bill.seller_data.dl_number) || '').toLowerCase();
      if (dl.includes(query)) return true;

      // Check nested medicines and batch numbers inside this bill
      if (bill.items && Array.isArray(bill.items)) {
        for (const it of bill.items) {
          const medName = (it.name || '').toLowerCase();
          const genName = (it.generic_name || it.genericName || '').toLowerCase();
          const bNo = (it.batch_no || it.batchNo || '').toLowerCase();
          if (medName.includes(query) || genName.includes(query) || bNo.includes(query)) {
            return true;
          }
        }
      }

      return false;
    });

    // 2. Date Filtering
    const dateVal = billHistoryDateFilter ? billHistoryDateFilter.value : 'all';
    const nowMs = Date.now();
    if (dateVal === 'today') {
      const todayStr = new Date().toISOString().split('T')[0];
      filtered = filtered.filter(b => {
        if (b.date === todayStr) return true;
        if (b.createdAt) {
          const d = new Date(b.createdAt * 1000).toISOString().split('T')[0];
          return d === todayStr;
        }
        return false;
      });
    } else if (dateVal === '7days') {
      const sevenDaysAgo = nowMs - (7 * 24 * 60 * 60 * 1000);
      filtered = filtered.filter(b => {
        const ts = b.createdAt ? b.createdAt * 1000 : (b.date ? new Date(b.date).getTime() : 0);
        return ts >= sevenDaysAgo;
      });
    } else if (dateVal === '30days') {
      const thirtyDaysAgo = nowMs - (30 * 24 * 60 * 60 * 1000);
      filtered = filtered.filter(b => {
        const ts = b.createdAt ? b.createdAt * 1000 : (b.date ? new Date(b.date).getTime() : 0);
        return ts >= thirtyDaysAgo;
      });
    }

    // 3. Sorting
    const sortVal = billHistorySortFilter ? billHistorySortFilter.value : 'newest';
    filtered.sort((a, b) => {
      if (sortVal === 'newest') {
        const aT = a.createdAt ? a.createdAt * 1000 : (a.date ? new Date(a.date).getTime() : 0);
        const bT = b.createdAt ? b.createdAt * 1000 : (b.date ? new Date(b.date).getTime() : 0);
        return bT - aT;
      } else if (sortVal === 'oldest') {
        const aT = a.createdAt ? a.createdAt * 1000 : (a.date ? new Date(a.date).getTime() : 0);
        const bT = b.createdAt ? b.createdAt * 1000 : (b.date ? new Date(b.date).getTime() : 0);
        return aT - bT;
      } else if (sortVal === 'highest_amount') {
        return (b.totalAmount || 0) - (a.totalAmount || 0);
      } else if (sortVal === 'lowest_amount') {
        return (a.totalAmount || 0) - (b.totalAmount || 0);
      }
      return 0;
    });

    // 4. Update Status Bar
    if (billHistoryResultsCount) {
      if (query) {
        billHistoryResultsCount.textContent = `Search results for "${query}" — ${filtered.length} bill${filtered.length === 1 ? '' : 's'} found`;
      } else {
        billHistoryResultsCount.textContent = `Showing ${filtered.length} of ${pharmacyDb.bills.length} purchase bill${pharmacyDb.bills.length === 1 ? '' : 's'}`;
      }
    }

    // 5. Render Cards or No-Results State
    if (filtered.length === 0) {
      billHistoryGrid.innerHTML = '';
      billHistoryGrid.hidden = true;
      if (billHistoryNoResultsState) {
        billHistoryNoResultsState.hidden = false;
        const noResDesc = document.getElementById('billHistoryNoResultsDesc');
        if (noResDesc) {
          noResDesc.textContent = query 
            ? `No purchase bills match "${query}". Try searching by distributor name, invoice number, or medicine name.`
            : 'No purchase bills match the selected date filter.';
        }
      }
      return;
    }

    if (billHistoryNoResultsState) billHistoryNoResultsState.hidden = true;
    billHistoryGrid.hidden = false;

    billHistoryGrid.innerHTML = filtered.map(bill => {
      const itemsList = bill.items || [];
      const medPreview = itemsList.slice(0, 3).map(it => it.name).filter(Boolean);
      const remainingCount = itemsList.length - medPreview.length;
      const placeText = bill.place || (bill.seller_data && (bill.seller_data.place || bill.seller_data.city)) || '';
      const gstinText = bill.gstin || (bill.seller_data && bill.seller_data.gstin) || '';
      const dlText = bill.dlNumber || (bill.seller_data && bill.seller_data.dl_number) || '';
      const totalFmt = (bill.totalAmount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const dateDisplay = bill.date || (bill.createdAt ? new Date(bill.createdAt * 1000).toISOString().split('T')[0] : 'Recent');

      return `
        <div class="bill-history-card gradient-border-card" data-bill-id="${bill.id}">
          <div class="bill-card-top">
            <div class="bill-card-supplier-info">
              <div class="bill-avatar-badge">🏢</div>
              <div>
                <h4 class="bill-distributor-heading">${bill.distributor || 'Purchase Supplier'}</h4>
                <div class="bill-meta-sub">
                  <span class="mono-badge">#${bill.invoiceNo || 'UNSPECIFIED'}</span>
                  <span>•</span>
                  <span>${dateDisplay}</span>
                  ${placeText ? `<span>•</span><span class="place-tag">📍 ${placeText}</span>` : ''}
                </div>
              </div>
            </div>
            <div class="bill-card-amount-box">
              <div class="bill-amount-val">₹${totalFmt}</div>
              <span class="bill-items-count-pill">${bill.itemsCount || itemsList.length || 1} Medicines</span>
            </div>
          </div>

          <!-- Compliance & Tags Row -->
          ${(gstinText || dlText) ? `
            <div class="bill-compliance-chips">
              ${gstinText ? `<span class="compliance-chip">GST: ${gstinText}</span>` : ''}
              ${dlText ? `<span class="compliance-chip">DL: ${dlText}</span>` : ''}
            </div>
          ` : ''}

          <!-- Medicine Line Items Preview -->
          ${medPreview.length > 0 ? `
            <div class="bill-med-preview-row">
              <span class="med-preview-label">Medicines:</span>
              <div class="med-preview-tags">
                ${medPreview.map(m => `<span class="med-chip">${m}</span>`).join('')}
                ${remainingCount > 0 ? `<span class="med-chip-more">+${remainingCount} more</span>` : ''}
              </div>
            </div>
          ` : ''}

          <!-- Card Actions Footer -->
          <div class="bill-card-footer">
            <button type="button" class="btn-primary btn-view-bill-card" data-bill-id="${bill.id}" style="height: 32px; font-size: 0.75rem; padding: 0 0.85rem;">
              📄 View Full Bill
            </button>
            ${(bill.originalFileUrl || bill.id) ? `
              <a href="${getBillDocumentUrl(bill)}" target="_blank" class="btn-secondary" style="height: 32px; font-size: 0.75rem; padding: 0 0.75rem; display: inline-flex; align-items: center; gap: 0.35rem;" onclick="event.stopPropagation();">
                <span>👁️ Original</span>
                <span style="font-size: 0.65rem;">↗</span>
              </a>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');

    // Attach click listeners to cards and buttons
    billHistoryGrid.querySelectorAll('.bill-history-card').forEach(card => {
      card.addEventListener('click', (e) => {
        // Prevent trigger if clicking original file link
        if (e.target.closest('a')) return;
        const bId = card.getAttribute('data-bill-id');
        if (bId) openBillDetail(bId);
      });
    });

    billHistoryGrid.querySelectorAll('.btn-view-bill-card').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bId = btn.getAttribute('data-bill-id');
        if (bId) openBillDetail(bId);
      });
    });
  };

  // Search & Filter Event Listeners
  if (billHistorySearchInput) {
    let debounceTimer = null;
    billHistorySearchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        renderBillHistoryView();
      }, 150);
    });
  }

  if (billHistoryClearSearchBtn) {
    billHistoryClearSearchBtn.addEventListener('click', () => {
      if (billHistorySearchInput) billHistorySearchInput.value = '';
      renderBillHistoryView();
    });
  }

  if (billHistoryRemoveQueryBtn) {
    billHistoryRemoveQueryBtn.addEventListener('click', () => {
      if (billHistorySearchInput) billHistorySearchInput.value = '';
      renderBillHistoryView();
    });
  }

  if (billHistoryDateFilter) {
    billHistoryDateFilter.addEventListener('change', renderBillHistoryView);
  }

  if (billHistorySortFilter) {
    billHistorySortFilter.addEventListener('change', renderBillHistoryView);
  }

  if (billHistoryResetFiltersBtn) {
    billHistoryResetFiltersBtn.addEventListener('click', () => {
      if (billHistorySearchInput) billHistorySearchInput.value = '';
      if (billHistoryDateFilter) billHistoryDateFilter.value = 'all';
      if (billHistorySortFilter) billHistorySortFilter.value = 'newest';
      renderBillHistoryView();
    });
  }

  // ==========================================================================
  // 7C. DETAILED BILL VIEW & ORIGINAL DOCUMENT VIEWER MODAL
  // ==========================================================================
  const openBillDetail = (billId) => {
    if (!billDetailModal) return;

    const bill = pharmacyDb.bills.find(b => b.id === billId);
    if (!bill) {
      alert('Bill record not found.');
      return;
    }

    const sellerObj = bill.seller_data && typeof bill.seller_data === 'object' ? bill.seller_data : {};
    const distributorName = bill.distributor || 'Unspecified Supplier';
    const sellerShopName = sellerObj.name || bill.sellerName || distributorName;
    const placeVal = bill.place || sellerObj.place || sellerObj.city || sellerObj.state || '—';
    const addrVal = bill.address || sellerObj.address || '—';
    const gstinVal = bill.gstin || sellerObj.gstin || '—';
    const dlVal = bill.dlNumber || sellerObj.dl_number || '—';
    const phoneVal = bill.phone || sellerObj.phone || '—';
    const invNo = bill.invoiceNo || 'UNSPECIFIED';
    const invDate = bill.date || (bill.createdAt ? new Date(bill.createdAt * 1000).toISOString().split('T')[0] : '—');
    const totalFmt = `₹${(bill.totalAmount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const itemsList = bill.items || [];
    const countVal = itemsList.length || bill.itemsCount || 1;

    if (billDetailModalTitle) billDetailModalTitle.textContent = `Invoice #${invNo} • ${distributorName}`;
    if (billDetailModalSubtitle) billDetailModalSubtitle.textContent = `Purchase Record • Date: ${invDate}`;
    if (billDetailDistributorName) billDetailDistributorName.textContent = distributorName;
    if (billDetailSellerName) billDetailSellerName.textContent = sellerShopName;
    if (billDetailPlace) billDetailPlace.textContent = placeVal;
    if (billDetailAddress) billDetailAddress.textContent = addrVal;
    if (billDetailGstin) billDetailGstin.textContent = gstinVal;
    if (billDetailDlNumber) billDetailDlNumber.textContent = dlVal;
    if (billDetailPhone) billDetailPhone.textContent = phoneVal;
    if (billDetailId) billDetailId.textContent = bill.id || '—';
    if (billDetailInvoiceNo) billDetailInvoiceNo.textContent = invNo;
    if (billDetailInvoiceDate) billDetailInvoiceDate.textContent = invDate;
    if (billDetailItemsCount) billDetailItemsCount.textContent = `${countVal} medicines recorded`;
    if (billDetailTotalAmount) billDetailTotalAmount.textContent = totalFmt;
    if (billDetailItemsBadge) billDetailItemsBadge.textContent = countVal;

    // Document Viewer Configuration
    const docUrl = getBillDocumentUrl(bill);
    const downloadUrl = getBillDocumentUrl(bill, true);
    const fName = bill.fileName || (bill.originalFileUrl ? bill.originalFileUrl.split('/').pop() : `Invoice_${invNo}.jpg`);
    if (billDetailDocFilename) billDetailDocFilename.textContent = fName;

    const hasDoc = Boolean(docUrl && (bill.originalFileUrl || bill.id));

    if (billDetailViewOriginalBtn) {
      if (hasDoc) {
        billDetailViewOriginalBtn.href = docUrl;
        billDetailViewOriginalBtn.hidden = false;
      } else {
        billDetailViewOriginalBtn.hidden = true;
      }
    }

    if (billDetailDownloadOriginalBtn) {
      if (hasDoc) {
        billDetailDownloadOriginalBtn.href = downloadUrl;
        billDetailDownloadOriginalBtn.setAttribute('download', fName);
        billDetailDownloadOriginalBtn.hidden = false;
      } else {
        billDetailDownloadOriginalBtn.hidden = true;
      }
    }

    const isPdf = (bill.fileType && bill.fileType.toLowerCase() === 'pdf') || 
                  (bill.originalFileUrl && bill.originalFileUrl.toLowerCase().endsWith('.pdf')) ||
                  (fName && fName.toLowerCase().endsWith('.pdf'));

    if (!hasDoc) {
      if (billDetailDocImg) billDetailDocImg.style.display = 'none';
      if (billDetailPdfNotice) billDetailPdfNotice.style.display = 'none';
      if (billDetailNoDocNotice) billDetailNoDocNotice.style.display = 'block';
    } else if (isPdf) {
      if (billDetailDocImg) billDetailDocImg.style.display = 'none';
      if (billDetailNoDocNotice) billDetailNoDocNotice.style.display = 'none';
      if (billDetailPdfNotice) billDetailPdfNotice.style.display = 'block';
      if (billDetailOpenPdfBtn) billDetailOpenPdfBtn.href = docUrl;
    } else {
      if (billDetailPdfNotice) billDetailPdfNotice.style.display = 'none';
      if (billDetailNoDocNotice) billDetailNoDocNotice.style.display = 'none';
      if (billDetailDocImg) {
        billDetailDocImg.src = docUrl;
        billDetailDocImg.style.display = 'block';
      }
    }

    // Render Confirmed Line Items Table
    if (billDetailItemsTbody) {
      if (itemsList.length === 0) {
        billDetailItemsTbody.innerHTML = `
          <tr>
            <td colspan="11" style="text-align: center; color: var(--color-text-muted); padding: 1.5rem;">
              No detailed line items recorded for this invoice.
            </td>
          </tr>
        `;
      } else {
        billDetailItemsTbody.innerHTML = itemsList.map((it, idx) => {
          const pRate = parseFloat(it.purchase_rate !== undefined ? it.purchase_rate : (it.purchaseRate || 0)) || 0;
          const mrp = parseFloat(it.mrp !== undefined && it.mrp !== null ? it.mrp : pRate) || pRate;
          const qty = parseFloat(it.quantity) || 1;
          const lineTot = (qty * pRate).toFixed(2);
          const exp = it.expiry_date || it.expiryDate || '—';
          const batch = it.batch_no || it.batchNo || '—';

          // Check current remaining stock in active inventory
          const activeBatch = pharmacyDb.batches.find(b => 
            (b.batchNo || b.batch_no || '').trim().toUpperCase() === batch.trim().toUpperCase() && 
            (b.name || '').trim().toLowerCase() === (it.name || '').trim().toLowerCase()
          );
          const currentRemaining = activeBatch ? activeBatch.quantity : 0;
          const stockPill = currentRemaining > 0
            ? `<span style="font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; background: #ecfdf5; color: #059669; font-weight: 600;">${currentRemaining} in stock</span>`
            : `<span style="font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; background: #fef2f2; color: #dc2626; font-weight: 600;">Sold / Cleared</span>`;

          return `
            <tr>
              <td style="font-size: 0.75rem; color: var(--color-text-muted); text-align: center;">${idx + 1}</td>
              <td><strong>${it.name || 'Medicine'}</strong></td>
              <td style="font-size: 0.8125rem; color: var(--color-text-muted);">${it.generic_name || it.genericName || '—'}</td>
              <td style="font-size: 0.8125rem;">${it.pack || 'Standard'}</td>
              <td><span class="mono-badge" style="font-size: 0.8125rem;">${batch}</span></td>
              <td style="font-size: 0.8125rem; font-weight: 600;">${exp}</td>
              <td style="font-size: 0.8125rem; font-weight: 700;">${qty}</td>
              <td>${stockPill}</td>
              <td style="font-family: var(--font-mono); font-size: 0.8125rem;">₹${pRate.toFixed(2)}</td>
              <td style="font-family: var(--font-mono); font-size: 0.8125rem;">₹${mrp.toFixed(2)}</td>
              <td style="font-family: var(--font-mono); font-size: 0.8125rem; font-weight: 700; color: var(--color-text-main);">₹${parseFloat(lineTot).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
            </tr>
          `;
        }).join('');
      }
    }

    billDetailModal.classList.remove('view-hidden');
  };

  const closeBillDetail = () => {
    if (billDetailModal) billDetailModal.classList.add('view-hidden');
  };

  if (backToBillHistoryBtn) backToBillHistoryBtn.addEventListener('click', closeBillDetail);
  if (closeBillDetailModalBtn) closeBillDetailModalBtn.addEventListener('click', closeBillDetail);
  if (closeBillDetailModalBottomBtn) closeBillDetailModalBottomBtn.addEventListener('click', closeBillDetail);
  if (billDetailModalBackdrop) billDetailModalBackdrop.addEventListener('click', closeBillDetail);

  if (toggleDocPreviewBtn && billDetailDocPreviewContainer) {
    toggleDocPreviewBtn.addEventListener('click', () => {
      const isHidden = billDetailDocPreviewContainer.style.display === 'none';
      if (isHidden) {
        billDetailDocPreviewContainer.style.display = 'block';
        toggleDocPreviewBtn.textContent = 'Hide Preview ▲';
      } else {
        billDetailDocPreviewContainer.style.display = 'none';
        toggleDocPreviewBtn.textContent = 'Show Preview ▼';
      }
    });
  }

  const inventorySearchInput = document.getElementById('inventorySearchInput');
  const inventoryExpiryFilter = document.getElementById('inventoryExpiryFilter');
  if (inventorySearchInput) inventorySearchInput.addEventListener('input', renderInventoryTable);
  if (inventoryExpiryFilter) inventoryExpiryFilter.addEventListener('change', renderInventoryTable);

  // ==========================================================================
  // 7D. GLOBAL TOPBAR SEARCH ENGINE (MEDICINES, BATCHES, SUPPLIERS & BILLS)
  // ==========================================================================
  const globalMedicineSearchInput = document.getElementById('globalMedicineSearchInput');
  const globalSearchClearBtn = document.getElementById('globalSearchClearBtn');
  const globalSearchDropdown = document.getElementById('globalSearchDropdown');
  const globalSearchResultsContainer = document.getElementById('globalSearchResultsContainer');
  const globalSearchWrapper = document.getElementById('globalSearchWrapper');

  const closeGlobalSearchDropdown = () => {
    if (globalSearchDropdown) globalSearchDropdown.classList.add('view-hidden');
  };

  const getFefoStatusBadge = (expiryStr) => {
    if (!expiryStr) return '';
    try {
      let expDate;
      if (expiryStr.length === 7) {
        const [y, m] = expiryStr.split('-');
        expDate = new Date(parseInt(y, 10), parseInt(m, 10), 0);
      } else {
        expDate = new Date(expiryStr);
      }
      const now = new Date();
      const diffTime = expDate.getTime() - now.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays < 0) {
        return '<span class="search-status-expired">Expired</span>';
      } else if (diffDays <= 90) {
        return `<span class="search-status-near">${diffDays}d left</span>`;
      } else {
        return '<span class="search-status-safe">Safe</span>';
      }
    } catch {
      return '';
    }
  };

  const renderGlobalSearchResults = (data, query) => {
    if (!globalSearchResultsContainer || !globalSearchDropdown) return;

    const medicines = data.medicines || [];
    const bills = data.bills || [];

    if (medicines.length === 0 && bills.length === 0) {
      globalSearchResultsContainer.innerHTML = `
        <div class="search-empty-notice">
          <p style="font-weight: 600; color: var(--color-text-main); margin-bottom: 0.25rem;">No matching medicine, batch, supplier or bill found.</p>
          <span>No database records matched "<strong>${query}</strong>".</span>
        </div>
      `;
      globalSearchDropdown.classList.remove('view-hidden');
      return;
    }

    let html = '';

    // 1. Medicines & Batches Section
    if (medicines.length > 0) {
      html += `
        <div class="search-section-header">
          <span>Medicines & Batches</span>
          <span style="font-size: 0.65rem; font-weight: 700;">${medicines.length} found</span>
        </div>
      `;
      html += medicines.map(m => {
        const statusBadge = getFefoStatusBadge(m.expiry_date || m.expiryDate);
        const bNo = m.batch_no || m.batchNo || '—';
        const qty = m.quantity || 0;
        const pRate = m.purchase_rate || m.purchaseRate || 0;
        const mrp = m.mrp || pRate;
        const dist = m.distributor || 'Direct';
        const rack = m.rack || 'Rack A-1';

        return `
          <div class="search-result-item" data-type="medicine" data-name="${m.name}" data-batch="${bNo}">
            <div class="search-item-left">
              <div class="search-item-title">${m.name}</div>
              <div class="search-item-sub">
                <span style="font-family: var(--font-mono); font-weight: 600; color: var(--color-text-main);">Batch: ${bNo}</span>
                <span>•</span>
                <span>${qty > 0 ? `${qty} in stock` : '<strong style="color:#dc2626;">Sold Out</strong>'}</span>
                <span>•</span>
                <span>Exp: ${m.expiry_date || m.expiryDate || '—'}</span>
                ${statusBadge}
                <span>•</span>
                <span style="color: var(--color-text-muted);">📍 ${rack}</span>
              </div>
            </div>
            <div class="search-item-right">
              <div class="search-item-price">₹${pRate.toFixed(2)}</div>
              <div style="font-size: 0.7rem; color: var(--color-text-muted);">MRP ₹${mrp.toFixed(2)}</div>
            </div>
          </div>
        `;
      }).join('');
    }

    // 2. Bills Section
    if (bills.length > 0) {
      html += `
        <div class="search-section-header" style="border-top: ${medicines.length > 0 ? '1px solid var(--color-border)' : 'none'};">
          <span>Purchase Bills & Invoices</span>
          <span style="font-size: 0.65rem; font-weight: 700;">${bills.length} found</span>
        </div>
      `;
      html += bills.map(b => {
        const dName = b.distributor || 'Supplier';
        const invNo = b.invoice_no || 'UNSPECIFIED';
        const invDate = b.invoice_date || (b.created_at ? new Date(b.created_at * 1000).toISOString().split('T')[0] : 'Recent');
        const totalFmt = (b.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const place = (b.seller_data && (b.seller_data.place || b.seller_data.city)) || '';

        return `
          <div class="search-result-item" data-type="bill" data-bill-id="${b.id}">
            <div class="search-item-left">
              <div class="search-item-title">📄 ${dName}</div>
              <div class="search-item-sub">
                <span class="mono-badge">#${invNo}</span>
                <span>•</span>
                <span>${invDate}</span>
                ${place ? `<span>•</span><span>📍 ${place}</span>` : ''}
              </div>
            </div>
            <div class="search-item-right">
              <div class="search-item-price" style="color: var(--color-text-main);">₹${totalFmt}</div>
              <div style="font-size: 0.7rem; color: #059669; font-weight: 600;">View Details →</div>
            </div>
          </div>
        `;
      }).join('');
    }

    globalSearchResultsContainer.innerHTML = html;
    globalSearchDropdown.classList.remove('view-hidden');

    // Attach click listeners to search results
    globalSearchResultsContainer.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const type = item.getAttribute('data-type');
        closeGlobalSearchDropdown();
        if (globalMedicineSearchInput) globalMedicineSearchInput.value = '';
        if (globalSearchClearBtn) globalSearchClearBtn.hidden = true;

        if (type === 'medicine') {
          const medName = item.getAttribute('data-name');
          switchWorkspaceTab('inventory');
          const invSearch = document.getElementById('inventorySearchInput');
          if (invSearch) {
            invSearch.value = medName;
            renderInventoryTable();
            invSearch.focus();
          }
        } else if (type === 'bill') {
          const bId = item.getAttribute('data-bill-id');
          switchWorkspaceTab('billhistory');
          if (bId) openBillDetail(bId);
        }
      });
    });
  };

  if (globalMedicineSearchInput) {
    let searchDebounce = null;
    globalMedicineSearchInput.addEventListener('input', () => {
      const q = globalMedicineSearchInput.value.trim();
      if (globalSearchClearBtn) globalSearchClearBtn.hidden = !q;

      if (!q) {
        closeGlobalSearchDropdown();
        return;
      }

      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(async () => {
        try {
          const res = await authenticatedFetch(`${API_BASE_URL}/api/search?q=${encodeURIComponent(q)}`);
          if (res.ok) {
            const data = await res.json();
            renderGlobalSearchResults(data, q);
          }
        } catch (e) {
          console.warn('Global search query error:', e);
        }
      }, 150);
    });

    globalMedicineSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeGlobalSearchDropdown();
      }
    });

    globalMedicineSearchInput.addEventListener('focus', () => {
      if (globalMedicineSearchInput.value.trim()) {
        globalMedicineSearchInput.dispatchEvent(new Event('input'));
      }
    });
  }

  if (globalSearchClearBtn) {
    globalSearchClearBtn.addEventListener('click', () => {
      if (globalMedicineSearchInput) globalMedicineSearchInput.value = '';
      globalSearchClearBtn.hidden = true;
      closeGlobalSearchDropdown();
    });
  }

  document.addEventListener('click', (e) => {
    if (globalSearchWrapper && !globalSearchWrapper.contains(e.target)) {
      closeGlobalSearchDropdown();
    }
  });

  // ==========================================================================
  // 8. DEDICATED SMART BILL CAPTURE & ZERO DUMMY EXTRACTION PIPELINE
  // ==========================================================================
  const billDropzoneWrapper = document.getElementById('billDropzoneWrapper');
  const billDropzone = document.getElementById('billDropzone');
  const billFileInput = document.getElementById('billFileInput');
  const browseFileBtn = document.getElementById('browseFileBtn');
  const cameraUploadBtn = document.getElementById('cameraUploadBtn');
  const manualEntryFallbackBtn = document.getElementById('manualEntryFallbackBtn');
  const manualEntryFromAlertBtn = document.getElementById('manualEntryFromAlertBtn');
  const retryBillUploadBtn = document.getElementById('retryBillUploadBtn');
  const billPipelineIndicator = document.getElementById('billPipelineIndicator');
  const billExtractionAlert = document.getElementById('billExtractionAlert');
  const ocrReviewContainer = document.getElementById('ocrReviewContainer');
  const ocrDistributorDisplay = document.getElementById('ocrDistributorDisplay');
  const ocrInvoiceNoDisplay = document.getElementById('ocrInvoiceNoDisplay');
  const ocrDateDisplay = document.getElementById('ocrDateDisplay');
  const ocrItemsCountDisplay = document.getElementById('ocrItemsCountDisplay');
  const simBillLogo = document.getElementById('simBillLogo');
  const simBillMeta = document.getElementById('simBillMeta');
  const simBillTable = document.getElementById('simBillTable');
  const originalBillPreviewImg = document.getElementById('originalBillPreviewImg');
  const ocrTableBody = document.getElementById('ocrTableBody');
  const ocrAddRowBtn = document.getElementById('ocrAddRowBtn');
  const ocrConfirmSaveBtn = document.getElementById('ocrConfirmSaveBtn');

  // Duplicate Bill Modal Elements
  const duplicateBillModal = document.getElementById('duplicateBillModal');
  const duplicateBillModalBackdrop = document.getElementById('duplicateBillModalBackdrop');
  const closeDuplicateBillModalBtn = document.getElementById('closeDuplicateBillModalBtn');
  const duplicateBillModalTitle = document.getElementById('duplicateBillModalTitle');
  const duplicateBillModalSubtitle = document.getElementById('duplicateBillModalSubtitle');
  const duplicateBillModalMessage = document.getElementById('duplicateBillModalMessage');
  const duplicateModalIcon = document.getElementById('duplicateModalIcon');
  const dupExistingDistributor = document.getElementById('dupExistingDistributor');
  const dupExistingInvoiceMeta = document.getElementById('dupExistingInvoiceMeta');
  const dupExistingAmount = document.getElementById('dupExistingAmount');
  const dupExistingAddedDate = document.getElementById('dupExistingAddedDate');
  const dupViewExistingBillBtn = document.getElementById('dupViewExistingBillBtn');
  const dupCancelUploadBtn = document.getElementById('dupCancelUploadBtn');
  const dupContinueAnywayBtn = document.getElementById('dupContinueAnywayBtn');

  const closeDuplicateModal = () => {
    if (duplicateBillModal) duplicateBillModal.classList.add('view-hidden');
  };

  if (closeDuplicateBillModalBtn) closeDuplicateBillModalBtn.addEventListener('click', closeDuplicateModal);
  if (duplicateBillModalBackdrop) duplicateBillModalBackdrop.addEventListener('click', closeDuplicateModal);

  const showDuplicateModal = (dupData, isExact = false, onContinue = null) => {
    if (!duplicateBillModal) return;
    const existing = dupData.existing_bill || {};
    const dName = existing.distributor || 'Supplier';
    const invNo = existing.invoice_no || 'UNSPECIFIED';
    const invDate = existing.invoice_date || (existing.created_at ? new Date(existing.created_at * 1000).toISOString().split('T')[0] : 'Recent');
    const totAmount = (existing.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    if (isExact) {
      if (duplicateBillModalTitle) {
        duplicateBillModalTitle.textContent = 'Bill Already Uploaded';
        duplicateBillModalTitle.style.color = '#dc2626';
      }
      if (duplicateModalIcon) {
        duplicateModalIcon.textContent = '🛑';
        duplicateModalIcon.style.background = '#fef2f2';
        duplicateModalIcon.style.color = '#dc2626';
      }
      if (duplicateBillModalSubtitle) duplicateBillModalSubtitle.textContent = 'Exact document duplicate detected';
      if (duplicateBillModalMessage) duplicateBillModalMessage.textContent = 'This exact purchase bill file has already been added to your Bill History. To prevent double inventory counting, duplicate bill files are not re-processed.';
      if (dupContinueAnywayBtn) dupContinueAnywayBtn.hidden = true;
    } else {
      if (duplicateBillModalTitle) {
        duplicateBillModalTitle.textContent = 'Possible Duplicate Bill';
        duplicateBillModalTitle.style.color = '#d97706';
      }
      if (duplicateModalIcon) {
        duplicateModalIcon.textContent = '⚠️';
        duplicateModalIcon.style.background = '#fef3c7';
        duplicateModalIcon.style.color = '#d97706';
      }
      if (duplicateBillModalSubtitle) duplicateBillModalSubtitle.textContent = 'Matching supplier & invoice number';
      if (duplicateBillModalMessage) duplicateBillModalMessage.textContent = `We found an existing bill from "${dName}" with Invoice #${invNo}. Please confirm if this is a new separate purchase or already recorded.`;
      if (dupContinueAnywayBtn) {
        dupContinueAnywayBtn.hidden = false;
        dupContinueAnywayBtn.onclick = () => {
          closeDuplicateModal();
          if (typeof onContinue === 'function') onContinue();
        };
      }
    }

    if (dupExistingDistributor) dupExistingDistributor.textContent = dName;
    if (dupExistingInvoiceMeta) dupExistingInvoiceMeta.textContent = `Invoice #${invNo} • Date: ${invDate}`;
    if (dupExistingAmount) dupExistingAmount.textContent = `₹${totAmount}`;
    if (dupExistingAddedDate) dupExistingAddedDate.textContent = `📅 Recorded in Bill History`;

    if (dupViewExistingBillBtn) {
      dupViewExistingBillBtn.onclick = () => {
        closeDuplicateModal();
        if (ocrReviewContainer) ocrReviewContainer.hidden = true;
        switchWorkspaceTab('billhistory');
        if (existing.id) openBillDetail(existing.id);
      };
    }

    if (dupCancelUploadBtn) {
      dupCancelUploadBtn.onclick = () => {
        closeDuplicateModal();
        if (ocrReviewContainer) ocrReviewContainer.hidden = true;
        if (billFileInput) billFileInput.value = '';
      };
    }

    duplicateBillModal.classList.remove('view-hidden');
  };

  let currentCapturedBill = null;

  const setPipelineStep = (stepNumber) => {
    if (!billPipelineIndicator) return;
    billPipelineIndicator.hidden = false;
    for (let i = 1; i <= 6; i++) {
      const stepEl = document.getElementById(`pipeStep${i}`);
      if (stepEl) {
        if (i < stepNumber) {
          stepEl.className = 'pipeline-step completed';
        } else if (i === stepNumber) {
          stepEl.className = 'pipeline-step active';
        } else {
          stepEl.className = 'pipeline-step';
        }
      }
    }
  };

  const processBillFile = async (file) => {
    if (!file) return;

    if (billExtractionAlert) billExtractionAlert.hidden = true;
    if (ocrReviewContainer) ocrReviewContainer.hidden = true;

    setPipelineStep(1); // 1. Uploading...

    const formData = new FormData();
    formData.append('bill', file);

    const t2 = setTimeout(() => setPipelineStep(2), 400);  // 2. Reading document...
    const t3 = setTimeout(() => setPipelineStep(3), 1200); // 3. Understanding invoice...
    const t4 = setTimeout(() => setPipelineStep(4), 2200); // 4. Extracting bill information...

    try {
      const res = await fetch(`${API_BASE_URL}/api/bills/analyze`, {
        method: 'POST',
        headers: sessionToken ? { 'Authorization': `Bearer ${sessionToken}` } : {},
        body: formData
      });

      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);

      setPipelineStep(5); // 5. Checking extracted fields...

      const data = await res.json();

      // Check Level 1 exact hash duplicate
      if (res.status === 409 && data.is_exact_duplicate) {
        if (billPipelineIndicator) billPipelineIndicator.hidden = true;
        showDuplicateModal(data, true);
        return;
      }

      if (!res.ok || !data.success || !data.items || data.items.length === 0) {
        // STRICT ZERO DUMMY RULE: Never generate fake medicines on failure
        if (billPipelineIndicator) billPipelineIndicator.hidden = true;
        if (billExtractionAlert) {
          billExtractionAlert.hidden = false;
          const desc = document.getElementById('billExtractionAlertDesc');
          if (desc) desc.textContent = data.error || 'Unable to confidently extract medicines from this document. Please review and enter details manually.';
        }
        return;
      }

      setPipelineStep(6); // 6. Ready for review.
      setTimeout(() => {
        if (billPipelineIndicator) billPipelineIndicator.hidden = true;
      }, 1000);

      // Check Level 2 metadata duplicate warning
      if (data.possible_duplicate && data.existing_bill) {
        showDuplicateModal(data, false, () => {
          loadSideBySideReview(data, file, true);
        });
      } else {
        loadSideBySideReview(data, file, false);
      }
    } catch (e) {
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      if (billPipelineIndicator) billPipelineIndicator.hidden = true;
      if (billExtractionAlert) {
        billExtractionAlert.hidden = false;
        const desc = document.getElementById('billExtractionAlertDesc');
        if (desc) desc.textContent = 'Unable to reach EXPIREDNOT server. Please check your internet connection or enter details manually.';
      }
    }
  };

<<<<<<< HEAD
      let totalBillAmount = 0;

     payloadItems.forEach(item => {
        const lineTotal = item.quantity * item.purchase_rate;
        totalBillAmount += lineTotal;

        // Auto-detect demand tier from the medicine's printed name
        const tier = window.InventoryRules 
          ? window.InventoryRules.inferDemandTier(item.name) 
          : 'MEDIUM_DEMAND';

        pharmacyDb.batches.unshift({
          id: 'B_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          name: item.name,
          pack: item.pack,
          batchNo: item.batch_no,
          expiryDate: item.expiry_date,
          quantity: item.quantity,
          purchaseRate: item.purchase_rate,
          mrp: item.mrp || (item.purchase_rate * 1.3),
          rack: 'Rack A-1',
          distributor: distributor,
          demandTier: tier, // Saved with auto-detected tier
          createdAt: new Date().toISOString()
        });
      });

      // Record the bill in history
      pharmacyDb.bills.unshift({
        id: 'BILL_' + Date.now(),
        distributor: distributor,
        invoiceNo: invoiceNo,
        date: invoiceDate,
        totalAmount: totalBillAmount,
        itemsCount: payloadItems.length,
        originalFileUrl: currentCapturedBill.original_file_url || '',
        timestamp: 'Just now'
      });

      pharmacyDb.activity.unshift({
        id: 'ACT_' + Date.now(),
        text: `Ingested ${distributor} Invoice #${invoiceNo} (${payloadItems.length} medicines)`,
        timestamp: 'Just now'
      });

      // Persist data and reset review container
      savePharmacyData();
      currentCapturedBill = null;
      if (ocrReviewContainer) ocrReviewContainer.hidden = true;

      ocrConfirmSaveBtn.disabled = false;
      ocrConfirmSaveBtn.textContent = 'Confirm & Add to Inventory →';

      // Refresh view and transition to dashboard
      refreshAllWorkspaceViews();
      switchWorkspaceTab('dashboard');
      alert(`✓ Invoice #${invoiceNo} processed! Added ${payloadItems.length} medicines to inventory.`);
    });
  }

  const loadSideBySideReview = (invoiceObj, file = null) => {
=======
  const loadSideBySideReview = (invoiceObj, file = null, allowDuplicate = false) => {
>>>>>>> 8328e7a6a60184d811dac1cafd69311e92dd1546
    currentCapturedBill = JSON.parse(JSON.stringify(invoiceObj));
    currentCapturedBill.allow_duplicate = Boolean(allowDuplicate);

    if (ocrDistributorDisplay) ocrDistributorDisplay.textContent = currentCapturedBill.distributor || '—';
    if (ocrInvoiceNoDisplay) ocrInvoiceNoDisplay.textContent = currentCapturedBill.invoice_no || currentCapturedBill.invoiceNo || '—';
    if (ocrDateDisplay) ocrDateDisplay.textContent = currentCapturedBill.invoice_date || currentCapturedBill.date || '—';
    if (ocrItemsCountDisplay) ocrItemsCountDisplay.textContent = currentCapturedBill.items ? currentCapturedBill.items.length : 0;

    if (simBillLogo) simBillLogo.textContent = (currentCapturedBill.distributor || 'PURCHASE INVOICE').toUpperCase();
    if (simBillMeta) simBillMeta.textContent = currentCapturedBill.invoice_no ? `TAX INVOICE #${currentCapturedBill.invoice_no}` : 'TAX INVOICE';

    if (file && originalBillPreviewImg) {
      if (file.type === 'application/pdf') {
        originalBillPreviewImg.style.display = 'none';
        if (simBillTable) {
          simBillTable.innerHTML = `
            <div style="padding: 1.5rem; text-align: center; background: #f8fafc; border-radius: 8px; border: 1px dashed #cbd5e1;">
              <span style="font-size: 2rem;">📄</span>
              <p style="font-weight: 700; margin: 0.5rem 0 0.25rem 0; color: #1e293b;">${file.name}</p>
              <p style="font-size: 0.75rem; color: #64748b;">PDF Document (${(file.size / 1024).toFixed(1)} KB)</p>
            </div>
          `;
        }
      } else {
        const reader = new FileReader();
        reader.onload = (e) => {
          originalBillPreviewImg.src = e.target.result;
          originalBillPreviewImg.style.display = 'block';
        };
        reader.readAsDataURL(file);
      }
    }

    if (simBillTable && file && file.type !== 'application/pdf') {
      simBillTable.innerHTML = (currentCapturedBill.items || []).map(item => `
        <div class="sim-line">
          <span>${item.name || 'Medicine'} (${item.batch_no || item.batchNo || '—'})</span>
          <span>${item.quantity || 0} × ₹${item.purchase_rate !== undefined && item.purchase_rate !== null ? item.purchase_rate : '—'}</span>
        </div>
      `).join('');
    }

    renderOcrTable();

    if (ocrReviewContainer) {
      ocrReviewContainer.hidden = false;
      ocrReviewContainer.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const renderOcrTable = () => {
    if (!ocrTableBody || !currentCapturedBill) return;

    ocrTableBody.innerHTML = (currentCapturedBill.items || []).map((item, idx) => {
      const pRate = (item.purchase_rate !== undefined && item.purchase_rate !== null) ? item.purchase_rate : (item.purchaseRate !== undefined ? item.purchaseRate : '');
      const bNo = (item.batch_no !== undefined && item.batch_no !== null) ? item.batch_no : (item.batchNo || '');
      const expDate = (item.expiry_date !== undefined && item.expiry_date !== null) ? item.expiry_date : (item.expiryDate || '');
      const mrpVal = (item.mrp !== undefined && item.mrp !== null) ? item.mrp : '';
      const qtyVal = (item.quantity !== undefined && item.quantity !== null) ? item.quantity : '';
      const rowTotal = (parseFloat(qtyVal) || 0) * (parseFloat(pRate) || 0);
      
      const isHighConf = item.conf === 'high' && !item.needs_verification;
      const noteTooltip = (item.validation_notes && item.validation_notes.length > 0) ? item.validation_notes.join(', ') : 'Requires pharmacist review';
      const confBadge = isHighConf
        ? `<span class="conf-badge conf-high">✓ Confident</span>`
        : `<span class="conf-badge conf-unverified" title="${noteTooltip}">⚠ Verify</span>`;

      return `
        <tr data-index="${idx}">
          <td>${confBadge}</td>
          <td><input type="text" value="${item.name || ''}" class="form-input ocr-in-name" style="height:32px; padding:0 0.5rem;" placeholder="Exact Medicine Name" required></td>
          <td><input type="text" value="${item.pack || ''}" class="form-input ocr-in-pack" style="height:32px; padding:0 0.5rem; width:65px;" placeholder="Pack"></td>
          <td><input type="text" value="${bNo}" class="form-input ocr-in-batch mono-input" style="height:32px; padding:0 0.5rem; width:100px;" placeholder="BATCH" required></td>
          <td><input type="text" value="${expDate}" class="form-input ocr-in-exp mono-input" style="height:32px; padding:0 0.5rem; width:90px;" placeholder="YYYY-MM" required></td>
          <td><input type="number" value="${qtyVal}" min="1" class="form-input ocr-in-qty" style="height:32px; padding:0 0.5rem; width:70px;" placeholder="Qty" required></td>
          <td><input type="number" value="${pRate}" min="0" step="0.01" class="form-input ocr-in-rate" style="height:32px; padding:0 0.5rem; width:80px;" placeholder="Rate" required></td>
          <td><input type="number" value="${mrpVal}" min="0" step="0.01" class="form-input ocr-in-mrp" style="height:32px; padding:0 0.5rem; width:80px;" placeholder="MRP"></td>
          <td><strong style="font-family:var(--font-mono);">₹${rowTotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
          <td>
            <button type="button" class="btn-secondary" style="height:26px; padding:0 0.4rem; color:var(--status-critical);" onclick="window.removeCapturedLine(${idx})">×</button>
          </td>
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
          currentCapturedBill.items[idx].pack = inPack.value || null;
          currentCapturedBill.items[idx].batch_no = inBatch.value;
          currentCapturedBill.items[idx].expiry_date = inExp.value;
          currentCapturedBill.items[idx].quantity = inQty.value ? parseFloat(inQty.value) : null;
          currentCapturedBill.items[idx].purchase_rate = inRate.value ? parseFloat(inRate.value) : null;
          currentCapturedBill.items[idx].mrp = inMrp.value ? parseFloat(inMrp.value) : null;
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

  if (ocrAddRowBtn) {
    ocrAddRowBtn.addEventListener('click', () => {
      if (!currentCapturedBill) return;
      if (!currentCapturedBill.items) currentCapturedBill.items = [];
      currentCapturedBill.items.push({
        name: '',
        pack: null,
        batch_no: '',
        expiry_date: '',
        quantity: null,
        purchase_rate: null,
        mrp: null,
        conf: 'needs_verification',
        needs_verification: true
      });
      if (ocrItemsCountDisplay) ocrItemsCountDisplay.textContent = currentCapturedBill.items.length;
      renderOcrTable();
    });
  }

  // Manual fallback entry trigger
  const launchManualBillCapture = () => {
    if (billExtractionAlert) billExtractionAlert.hidden = true;
    loadSideBySideReview({
      distributor: '',
      invoice_no: '',
      invoice_date: new Date().toISOString().split('T')[0],
      items: [
        { name: '', pack: null, batch_no: '', expiry_date: '', quantity: null, purchase_rate: null, mrp: null, conf: 'needs_verification', needs_verification: true }
      ]
    });
  };

  if (manualEntryFallbackBtn) manualEntryFallbackBtn.addEventListener('click', launchManualBillCapture);
  if (manualEntryFromAlertBtn) manualEntryFromAlertBtn.addEventListener('click', launchManualBillCapture);
  if (retryBillUploadBtn && billFileInput) retryBillUploadBtn.addEventListener('click', () => billFileInput.click());

  if (browseFileBtn && billFileInput) {
    browseFileBtn.addEventListener('click', () => billFileInput.click());
  }
  if (cameraUploadBtn && billFileInput) {
    cameraUploadBtn.addEventListener('click', () => billFileInput.click());
  }

  if (billFileInput) {
    billFileInput.addEventListener('change', () => {
      if (billFileInput.files && billFileInput.files[0]) {
        processBillFile(billFileInput.files[0]);
      }
    });
  }

  // Drag and drop handler
  if (billDropzone) {
    billDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      billDropzone.style.borderColor = 'var(--brand-primary)';
    });
    billDropzone.addEventListener('dragleave', () => {
      billDropzone.style.borderColor = 'var(--color-border)';
    });
    billDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      billDropzone.style.borderColor = 'var(--color-border)';
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        processBillFile(e.dataTransfer.files[0]);
      }
    });
  }

  // Confirm Bill -> Save to Real DB (Human Review Gate)
  if (ocrConfirmSaveBtn) {
    ocrConfirmSaveBtn.addEventListener('click', async () => {
      if (!currentCapturedBill || !currentCapturedBill.items || currentCapturedBill.items.length === 0) {
        alert('Please maintain at least one valid line item.');
        return;
      }

      // Check required fields
      for (let i = 0; i < currentCapturedBill.items.length; i++) {
        const item = currentCapturedBill.items[i];
        const name = (item.name || '').trim();
        const bNo = (item.batch_no || item.batchNo || '').trim();
        const exp = (item.expiry_date || item.expiryDate || '').trim();
        const qty = parseFloat(item.quantity);
        const rate = parseFloat(item.purchase_rate !== undefined && item.purchase_rate !== null ? item.purchase_rate : item.purchaseRate);
        
        if (!name) {
          alert(`Item #${i + 1}: Please enter the exact medicine name.`);
          return;
        }
        if (!bNo) {
          alert(`Item #${i + 1} (${name}): Please enter the batch number.`);
          return;
        }
        if (!exp) {
          alert(`Item #${i + 1} (${name}): Please enter the expiry date (YYYY-MM).`);
          return;
        }
        if (isNaN(qty) || qty <= 0) {
          alert(`Item #${i + 1} (${name}): Please enter a valid quantity.`);
          return;
        }
        if (isNaN(rate) || rate < 0) {
          alert(`Item #${i + 1} (${name}): Please enter a valid purchase rate.`);
          return;
        }
      }

      ocrConfirmSaveBtn.disabled = true;
      ocrConfirmSaveBtn.textContent = 'Saving to Real Inventory…';

      const payload = {
        bill_id: currentCapturedBill.bill_id,
        distributor: currentCapturedBill.distributor || 'Unspecified Supplier',
        invoice_no: currentCapturedBill.invoice_no || currentCapturedBill.invoiceNo || 'UNSPECIFIED',
        invoice_date: currentCapturedBill.invoice_date || currentCapturedBill.date || new Date().toISOString().split('T')[0],
        original_file_url: currentCapturedBill.original_file_url || '',
        file_name: currentCapturedBill.file_name || (currentCapturedBill.original_file_url ? currentCapturedBill.original_file_url.split('/').pop() : ''),
        file_type: currentCapturedBill.file_type || '',
        seller_data: {
          name: currentCapturedBill.distributor || currentCapturedBill.seller_name || '',
          address: currentCapturedBill.seller_address || '',
          phone: currentCapturedBill.seller_phone || '',
          gstin: currentCapturedBill.seller_gstin || '',
          dl_number: currentCapturedBill.seller_dl || '',
          place: currentCapturedBill.seller_place || currentCapturedBill.place || ''
        },
        buyer_data: {
          name: currentCapturedBill.buyer_name || '',
          address: currentCapturedBill.buyer_address || '',
          phone: currentCapturedBill.buyer_phone || '',
          gstin: currentCapturedBill.buyer_gstin || ''
        },
        taxes_data: {
          subtotal: currentCapturedBill.subtotal || 0,
          cgst: currentCapturedBill.cgst || 0,
          sgst: currentCapturedBill.sgst || 0,
          igst: currentCapturedBill.igst || 0,
          discount: currentCapturedBill.discount || 0
        },
        allow_duplicate: Boolean(currentCapturedBill.allow_duplicate),
        items: currentCapturedBill.items.map(item => {
          const pRate = parseFloat(item.purchase_rate !== undefined && item.purchase_rate !== null ? item.purchase_rate : item.purchaseRate) || 0;
          const rawMrp = item.mrp !== undefined && item.mrp !== null ? parseFloat(item.mrp) : null;
          return {
            name: item.name.trim(),
            generic_name: item.generic_name || null,
            pack: item.pack || 'Standard',
            batch_no: (item.batch_no || item.batchNo || '').trim().toUpperCase(),
            expiry_date: (item.expiry_date || item.expiryDate || '').trim(),
            quantity: parseFloat(item.quantity) || 1,
            purchase_rate: pRate,
            mrp: rawMrp !== null && !isNaN(rawMrp) ? rawMrp : pRate
          };
        })
      };

      try {
        const res = await authenticatedFetch(`${API_BASE_URL}/api/bills/confirm`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        ocrConfirmSaveBtn.disabled = false;
        ocrConfirmSaveBtn.textContent = 'Confirm & Add to Inventory →';

        if (!res.ok) {
          alert(data.error || 'Failed to save bill.');
          return;
        }

        // Sync local DB copy
        payload.items.forEach(item => {
          pharmacyDb.batches.push({
            id: 'B_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36),
            name: item.name,
            pack: item.pack,
            batchNo: item.batch_no,
            expiryDate: item.expiry_date,
            quantity: item.quantity,
            purchaseRate: item.purchase_rate,
            mrp: item.mrp !== undefined && item.mrp !== null ? item.mrp : item.purchase_rate,
            rack: 'Rack A-1',
            distributor: payload.distributor,
            createdAt: new Date().toISOString()
          });

          pharmacyDb.movements.unshift({
            id: 'MOV_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36),
            timestamp: 'Just now',
            type: 'Purchased',
            medicineName: item.name,
            batchNo: item.batch_no,
            quantity: item.quantity,
            value: item.quantity * item.purchase_rate,
            notes: `Invoice #${payload.invoice_no}`
          });
        });

        pharmacyDb.bills.unshift({
          id: data.bill_id || ('BILL_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36)),
          distributor: payload.distributor,
          seller_data: payload.seller_data,
          sellerName: payload.seller_data.name,
          place: payload.seller_data.place,
          address: payload.seller_data.address,
          gstin: payload.seller_data.gstin,
          dlNumber: payload.seller_data.dl_number,
          phone: payload.seller_data.phone,
          invoiceNo: payload.invoice_no,
          date: payload.invoice_date,
          totalAmount: data.total_amount || payload.items.reduce((s, it) => s + (it.quantity * it.purchase_rate), 0),
          itemsCount: payload.items.length,
          items: payload.items,
          originalFileUrl: payload.original_file_url || (data.bill_id ? `/api/bills/${data.bill_id}/document` : ''),
          fileName: payload.file_name,
          fileType: payload.file_type,
          timestamp: 'Just now',
          createdAt: Math.floor(Date.now() / 1000)
        });

        pharmacyDb.activity.unshift({
          id: 'ACT_' + Date.now(),
          text: `Ingested ${payload.distributor} Bill #${payload.invoice_no}`,
          timestamp: 'Just now'
        });

        savePharmacyData();
        currentCapturedBill = null;
        if (ocrReviewContainer) ocrReviewContainer.hidden = true;

        await fetchNotifications();
        refreshAllWorkspaceViews();
        switchWorkspaceTab('dashboard');
        showAppToast('New Bill Added', `Invoice #${payload.invoice_no} (${payload.distributor}) was successfully added to inventory.`);
      } catch (err) {
        ocrConfirmSaveBtn.disabled = false;
        ocrConfirmSaveBtn.textContent = 'Confirm & Add to Inventory →';
        alert('Unable to reach EXPIREDNOT server. Please check your internet connection.');
      }
    });
  }

  // ==========================================================================
  // 9. MODALS: MANUAL ADD MEDICINE, LOG MOVEMENT, ADD EXPENSE
  // ==========================================================================
  
  // Add Medicine Modal
  const addMedModal = document.getElementById('addMedModal');
  const addMedBackdrop = document.getElementById('addMedBackdrop');
  const topbarAddMedBtn = document.getElementById('topbarAddMedBtn');
  const emptyAddMedBtn = document.getElementById('emptyAddMedBtn');
  const inventoryAddMedBtn = document.getElementById('inventoryAddMedBtn');
  const closeAddMedBtn = document.getElementById('closeAddMedBtn');
  const cancelAddMedBtn = document.getElementById('cancelAddMedBtn');
  const addMedForm = document.getElementById('addMedForm');

  const openAddMedModal = () => {
    if (!addMedModal) return;
    addMedModal.classList.remove('view-hidden');
    addMedModal.classList.add('view-active');
    const mMedName = document.getElementById('mMedName');
    if (mMedName) mMedName.focus();
  };

  const closeAddMedModal = () => {
    if (!addMedModal) return;
    addMedModal.classList.remove('view-active');
    addMedModal.classList.add('view-hidden');
    if (addMedForm) addMedForm.reset();
  };

  if (topbarAddMedBtn) topbarAddMedBtn.addEventListener('click', openAddMedModal);
  if (emptyAddMedBtn) emptyAddMedBtn.addEventListener('click', openAddMedModal);
  if (inventoryAddMedBtn) inventoryAddMedBtn.addEventListener('click', openAddMedModal);
  if (addMedBackdrop) addMedBackdrop.addEventListener('click', closeAddMedModal);
  if (closeAddMedBtn) closeAddMedBtn.addEventListener('click', closeAddMedModal);
  if (cancelAddMedBtn) cancelAddMedBtn.addEventListener('click', closeAddMedModal);

<<<<<<< HEAD
  // Bulletproof Manual Add Medicine Handler
  // Bulletproof Manual Add Medicine Handler
=======
>>>>>>> 8328e7a6a60184d811dac1cafd69311e92dd1546
  if (addMedForm) {
    addMedForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const mMedName = document.getElementById('mMedName');
      const mBatchNo = document.getElementById('mBatchNo');
      const mExpiryDate = document.getElementById('mExpiryDate');
      const mQty = document.getElementById('mQty');
      const mPurchaseRate = document.getElementById('mPurchaseRate');
      const mMrp = document.getElementById('mMrp');
      const mRack = document.getElementById('mRack');
      const mDistributor = document.getElementById('mDistributor');

      if (!mMedName.value.trim() || !mBatchNo.value.trim() || !mExpiryDate.value || !mQty.value || !mPurchaseRate.value) {
        alert('Please fill all required fields.');
        return;
      }

      const qty = parseFloat(mQty.value) || 1;
<<<<<<< HEAD
      const rate = parseFloat(mPurchaseRate ? mPurchaseRate.value : 0) || 0;
      const mrp = parseFloat(mMrp ? mMrp.value : 0) || (rate > 0 ? rate * 1.3 : 0);

      // Auto-detect demand tier if AUTO is selected
      let selectedTier = mDemandTier ? mDemandTier.value : 'AUTO';
      if (selectedTier === 'AUTO' || !selectedTier) {
        selectedTier = window.InventoryRules 
          ? window.InventoryRules.inferDemandTier(mMedName.value.trim()) 
          : 'MEDIUM_DEMAND';
      }
=======
      const rate = parseFloat(mPurchaseRate.value) || 0;
>>>>>>> 8328e7a6a60184d811dac1cafd69311e92dd1546

      pharmacyDb.batches.push({
        id: 'B_' + Date.now(),
        name: mMedName.value.trim(),
        pack: 'Standard',
        batchNo: mBatchNo.value.trim().toUpperCase(),
        expiryDate: mExpiryDate.value,
        quantity: qty,
        purchaseRate: rate,
<<<<<<< HEAD
        mrp: mrp,
        rack: mRack && mRack.value.trim() ? mRack.value.trim() : 'Rack A-1',
        distributor: mDistributor && mDistributor.value.trim() ? mDistributor.value.trim() : 'Direct Supplier',
        demandTier: selectedTier,
        createdAt: new Date().toISOString()
      };

      // Add to local memory database
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
=======
        mrp: parseFloat(mMrp.value) || (rate * 1.3),
        rack: mRack.value.trim() || 'Rack A-1',
        distributor: mDistributor.value.trim() || 'Direct Supplier',
        createdAt: new Date().toISOString()
>>>>>>> 8328e7a6a60184d811dac1cafd69311e92dd1546
      });

      pharmacyDb.activity.unshift({
        id: 'ACT_' + Date.now(),
        text: `Manually added ${mMedName.value.trim()} (Batch #${mBatchNo.value.trim().toUpperCase()})`,
        timestamp: 'Just now'
      });

      savePharmacyData();
<<<<<<< HEAD

      try {
        await fetch(`${API_BASE_URL}/api/inventory`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            name: newBatch.name,
            batch_no: newBatch.batchNo,
            expiry_date: newBatch.expiryDate,
            quantity: newBatch.quantity,
            purchase_rate: newBatch.purchaseRate,
            mrp: newBatch.mrp,
            rack: newBatch.rack,
            distributor: newBatch.distributor
          })
        });
      } catch (err) {}

=======
>>>>>>> 8328e7a6a60184d811dac1cafd69311e92dd1546
      closeAddMedModal();
      refreshAllWorkspaceViews();
    });
  }

  // Log Movement Modal
  const movementModal = document.getElementById('movementModal');
  const movementBackdrop = document.getElementById('movementBackdrop');
  const logMovementBtn = document.getElementById('logMovementBtn');
  const closeMovementBtn = document.getElementById('closeMovementBtn');
  const cancelMovementBtn = document.getElementById('cancelMovementBtn');
  const movementForm = document.getElementById('movementForm');
  const movMedicineSelect = document.getElementById('movMedicineSelect');

  const openMovementModal = () => {
    if (!movementModal || !movMedicineSelect) return;
    const active = pharmacyDb.batches.filter(b => b.quantity > 0);
    if (active.length === 0) {
      alert('No active stock available to dispense or return.');
      return;
    }
    movMedicineSelect.innerHTML = active.map(b => `
      <option value="${b.id}">${b.name} (${b.batchNo}) - ${b.quantity} in stock</option>
    `).join('');

    movementModal.classList.remove('view-hidden');
    movementModal.classList.add('view-active');
  };

  const closeMovementModal = () => {
    if (!movementModal) return;
    movementModal.classList.remove('view-active');
    movementModal.classList.add('view-hidden');
    if (movementForm) movementForm.reset();
  };

  if (logMovementBtn) logMovementBtn.addEventListener('click', openMovementModal);
  if (movementBackdrop) movementBackdrop.addEventListener('click', closeMovementModal);
  if (closeMovementBtn) closeMovementBtn.addEventListener('click', closeMovementModal);
  if (cancelMovementBtn) cancelMovementBtn.addEventListener('click', closeMovementModal);

  if (movementForm) {
    movementForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const batchId = movMedicineSelect.value;
      const movType = document.getElementById('movType').value;
      const movQty = parseFloat(document.getElementById('movQty').value) || 1;
      const movNotes = document.getElementById('movNotes').value.trim();

      const batch = pharmacyDb.batches.find(b => b.id === batchId);
      if (!batch) return;

      if (movQty > batch.quantity) {
        alert(`Cannot dispense ${movQty} units. Only ${batch.quantity} units available.`);
        return;
      }

      batch.quantity -= movQty;
      const lineVal = movQty * batch.purchaseRate;

      pharmacyDb.movements.unshift({
        id: 'MOV_' + Date.now(),
        timestamp: 'Just now',
        type: movType,
        medicineName: batch.name,
        batchNo: batch.batchNo,
        quantity: movQty,
        value: lineVal,
        notes: movNotes
      });

      savePharmacyData();
      closeMovementModal();
      refreshAllWorkspaceViews();
    });
  }

  // Add Expense Modal
  const expenseModal = document.getElementById('expenseModal');
  const expenseBackdrop = document.getElementById('expenseBackdrop');
  const addExpenseBtn = document.getElementById('addExpenseBtn');
  const closeExpenseBtn = document.getElementById('closeExpenseBtn');
  const cancelExpenseBtn = document.getElementById('cancelExpenseBtn');
  const expenseForm = document.getElementById('expenseForm');

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

  if (addExpenseBtn) addExpenseBtn.addEventListener('click', openExpenseModal);
  if (expenseBackdrop) expenseBackdrop.addEventListener('click', closeExpenseModal);
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

      const newExpense = {
        id: 'EXP_' + Date.now(),
        date: new Date().toISOString().split('T')[0],
        category: expCategory,
        desc: expDesc,
        amount: expAmount
      };

      if (!pharmacyDb.expenses) pharmacyDb.expenses = [];
      pharmacyDb.expenses.unshift(newExpense);

      savePharmacyData();
      closeExpenseModal();
      renderExpensesView();
      alert(`✓ Recorded ₹${expAmount.toLocaleString('en-IN')} for ${expDesc}`);
    });
  }

  // ==========================================================================
  // 10. PRESENTATION DEMO MODE TOGGLE (ISOLATED)
  // ==========================================================================
  const loadDemoDataBtn = document.getElementById('loadDemoDataBtn');
  const clearAllDataBtn = document.getElementById('clearAllDataBtn');
  const demoModeBanner = document.getElementById('demoModeBanner');
  const exitDemoModeBtn = document.getElementById('exitDemoModeBtn');

  // Presentation Sample Dataset (Completely Isolated from Real Pharmacy DB)
  const presentationDemoData = {
    batches: [
      { id: 'DEMO_1', name: 'Augmentin 625 Duo Tablet', generic_name: 'Amoxicillin + Clavulanate', pack: '10s', batchNo: 'AUG-9821', expiryDate: '2026-09', quantity: 14, purchaseRate: 155, mrp: 204, rack: 'Rack A-2', distributor: 'Cipla Distributors', createdAt: new Date().toISOString() },
      { id: 'DEMO_2', name: 'Pan-D Capsule (15s)', generic_name: 'Pantoprazole + Domperidone', pack: '15s', batchNo: 'PND-4410', expiryDate: '2026-09', quantity: 28, purchaseRate: 185, mrp: 245, rack: 'Rack B-1', distributor: 'Sun Pharma Agency', createdAt: new Date().toISOString() },
      { id: 'DEMO_3', name: 'Telma-AM 40/5mg Tablet', generic_name: 'Telmisartan + Amlodipine', pack: '15s', batchNo: 'TLM-1092', expiryDate: '2026-10', quantity: 20, purchaseRate: 195, mrp: 260, rack: 'Rack C-4', distributor: 'Alkem Labs Branch', createdAt: new Date().toISOString() },
      { id: 'DEMO_4', name: 'Rosuvas 10mg Tablet', generic_name: 'Rosuvastatin', pack: '10s', batchNo: 'RSV-3318', expiryDate: '2027-02', quantity: 40, purchaseRate: 140, mrp: 195, rack: 'Rack D-1', distributor: 'Sun Pharma Agency', createdAt: new Date().toISOString() }
    ],
    bills: [
      { id: 'BILL_DEMO_1', distributor: 'Cipla Distributors', invoiceNo: 'CP-9812', date: '2026-08-10', totalAmount: 4200, itemsCount: 1, timestamp: '3 days ago' },
      { id: 'BILL_DEMO_2', distributor: 'Sun Pharma Agency', invoiceNo: 'SP-3910', date: '2026-08-12', totalAmount: 6850, itemsCount: 2, timestamp: '1 day ago' }
    ],
    movements: [
      { id: 'MOV_DEMO_1', timestamp: 'Yesterday', type: 'Sold', medicineName: 'Augmentin 625 Duo Tablet', batchNo: 'AUG-9821', quantity: 2, value: 310, notes: 'Counter Rx #1092' }
    ],
    expenses: [
      { id: 'EXP_DEMO_1', date: '2026-08-01', category: 'Rent', desc: 'Shop monthly rent', amount: 25000 }
    ],
    notifications: [
      { id: 'NOTIF_D1', text: 'Augmentin 625 Duo (AUG-9821) expires in 22 days. Dispense via FEFO.', type: 'expiry', timestamp: '1 hour ago', read: false }
    ],
    activity: [
      { id: 'ACT_D1', text: 'Ingested Cipla Distributors Bill #CP-9812 (₹4,200)', timestamp: '3 days ago' }
    ]
  };

  if (loadDemoDataBtn) {
    loadDemoDataBtn.addEventListener('click', () => {
      isDemoMode = true;
      realDbBackup = JSON.parse(JSON.stringify(pharmacyDb));
      pharmacyDb = JSON.parse(JSON.stringify(presentationDemoData));

      if (demoModeBanner) {
        demoModeBanner.hidden = false;
        demoModeBanner.style.display = 'flex';
      }
      refreshAllWorkspaceViews();
      switchWorkspaceTab('dashboard');
    });
  }

  if (exitDemoModeBtn) {
    exitDemoModeBtn.addEventListener('click', async () => {
      isDemoMode = false;
      if (demoModeBanner) {
        demoModeBanner.hidden = true;
        demoModeBanner.style.display = 'none';
      }

      if (realDbBackup) {
        pharmacyDb = realDbBackup;
      } else {
        pharmacyDb = { batches: [], bills: [], movements: [], expenses: [], notifications: [], activity: [] };
      }

      if (currentPharmacy && currentPharmacy.id) {
        await loadPharmacyData(currentPharmacy.id);
      }
      refreshAllWorkspaceViews();
    });
  }

  if (clearAllDataBtn) {
    clearAllDataBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to reset all records back to clean zero state?')) {
        isDemoMode = false;
        if (demoModeBanner) {
          demoModeBanner.hidden = true;
          demoModeBanner.style.display = 'none';
        }
        pharmacyDb = { batches: [], bills: [], movements: [], expenses: [], notifications: [], activity: [] };
        savePharmacyData();
        refreshAllWorkspaceViews();
        alert('Pharmacy inventory successfully reset to clean zero state.');
      }
    });
  }

  // ==========================================================================
  // 11. INITIAL PROTECTED SESSION CHECK & AUTH CONFIG BOOT
  // ==========================================================================
  fetchAuthConfig();

  const initSessionCheck = async () => {
    // Ensure demo mode is OFF on boot
    isDemoMode = false;
    if (demoModeBanner) {
      demoModeBanner.hidden = true;
      demoModeBanner.style.display = 'none';
    }

    // Attach Firebase Auth state listener to guard against unverified email/password sessions
    if (window.firebaseAuth && typeof window.firebaseAuth.onAuthStateChanged === 'function') {
      window.firebaseAuth.onAuthStateChanged(async (fbUser) => {
        if (fbUser) {
          const isPasswordProvider = fbUser.providerData && fbUser.providerData.some(p => p.providerId === 'password');
          if (isPasswordProvider) {
            try {
              await fbUser.reload();
            } catch {}
            if (!fbUser.emailVerified) {
              sessionStorage.removeItem(ACTIVE_SESSION_KEY);
              localStorage.removeItem(ACTIVE_SESSION_KEY);
              sessionStorage.removeItem(ACTIVE_TOKEN_KEY);
              localStorage.removeItem(ACTIVE_TOKEN_KEY);
              sessionToken = null;
              currentPharmacy = null;

              pendingRegistration.email = fbUser.email;
              const maskedDisplay = document.getElementById('maskedEmailDisplay');
              if (maskedDisplay) maskedDisplay.textContent = maskEmail(fbUser.email);

              showScreen('signup');
              goToOnboardingStep(2);
              showOtpNotice('Verify your email before continuing.', 'error');
            }
          }
        }
      });
    }

    // Direct synchronous check on boot
    if (window.firebaseAuth && window.firebaseAuth.currentUser) {
      const fbUser = window.firebaseAuth.currentUser;
      const isPasswordProvider = fbUser.providerData && fbUser.providerData.some(p => p.providerId === 'password');
      if (isPasswordProvider) {
        try {
          await fbUser.reload();
        } catch {}
        if (!fbUser.emailVerified) {
          sessionStorage.removeItem(ACTIVE_SESSION_KEY);
          localStorage.removeItem(ACTIVE_SESSION_KEY);
          sessionStorage.removeItem(ACTIVE_TOKEN_KEY);
          localStorage.removeItem(ACTIVE_TOKEN_KEY);
          sessionToken = null;
          currentPharmacy = null;

          pendingRegistration.email = fbUser.email;
          const maskedDisplay = document.getElementById('maskedEmailDisplay');
          if (maskedDisplay) maskedDisplay.textContent = maskEmail(fbUser.email);

          showScreen('signup');
          goToOnboardingStep(2);
          showOtpNotice('Verify your email before continuing.', 'error');
          return;
        }
      }
    }

    if (sessionToken) {
      try {
        const res = await fetch(`${API_BASE_URL}/api/auth/session`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) {
          const data = await res.json();
          if (data.authenticated && data.user) {
            currentPharmacy = data.user;
            sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(currentPharmacy));

            if (currentPharmacy.setup_completed || currentPharmacy.setupCompleted) {
              await loadPharmacyData(currentPharmacy.id);
              showScreen('dashboard');
              return;
            } else {
              showScreen('signup');
              goToOnboardingStep(3);
              return;
            }
          }
        }
      } catch {}
    }

    const activeSessionRaw = sessionStorage.getItem(ACTIVE_SESSION_KEY) || localStorage.getItem(ACTIVE_SESSION_KEY);
    if (activeSessionRaw) {
      try {
        currentPharmacy = JSON.parse(activeSessionRaw);
        if (currentPharmacy.setup_completed || currentPharmacy.setupCompleted) {
          loadPharmacyData(currentPharmacy.id);
          showScreen('dashboard');
        } else {
          showScreen('welcome');
        }
      } catch {
        showScreen('welcome');
      }
    } else {
      showScreen('welcome');
    }
  };

  initSessionCheck();
});
