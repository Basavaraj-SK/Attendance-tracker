// Authentication & Subscription Routing State
let currentUser = null;
let isAdmin = false;
let accessPrice = 99;
let authIsSignUp = false;

// Per-User Storage Keys
let STORAGE_KEY_SUBJECTS = 'attendflow_subjects_guest';
let STORAGE_KEY_LOGS = 'attendflow_logs_guest';
let STORAGE_KEY_HOLIDAYS = 'attendflow_holidays_guest';
let STORAGE_KEY_CONFIG = 'attendflow_config_guest';

function initAuth() {
  if (!auth) {
    console.error("AttendFlow Error: Firebase Auth is uninitialized.");
    return;
  }

  auth.onAuthStateChanged(async (user) => {
    const authModal = document.getElementById('authModal');
    const paywallModal = document.getElementById('paywallModal');
    const appHeader = document.getElementById('appHeader');
    const mainContent = document.getElementById('appMainContent');

    if (user) {
      currentUser = user;
      const userEmail = (user.email || '').toLowerCase().trim();
      
      // Strict normalized comparison
      isAdmin = (userEmail !== '' && userEmail === ADMIN_EMAIL);

      console.log(`AttendFlow: Authenticated as ${userEmail} | isAdmin: ${isAdmin}`);

      // Point localStorage keys to isolated user space
      STORAGE_KEY_SUBJECTS = `attendflow_subjects_${user.uid}`;
      STORAGE_KEY_LOGS = `attendflow_logs_${user.uid}`;
      STORAGE_KEY_HOLIDAYS = `attendflow_holidays_${user.uid}`;
      STORAGE_KEY_CONFIG = `attendflow_config_${user.uid}`;

      // Force hide Auth Modal
      if (authModal) {
        authModal.style.removeProperty('display');
        authModal.style.display = 'none';
        authModal.classList.add('hidden');
      }

      // Update user display pill
      const userPill = document.getElementById('userDisplayNamePill');
      if (userPill) userPill.innerText = user.displayName || user.email.split('@')[0];

      listenToGlobalConfig();

      // ==========================================
      // 1. INSTANT ADMIN BYPASS
      // ==========================================
      if (isAdmin) {
        const adminBadge = document.getElementById('adminBadge');
        const adminPricingBar = document.getElementById('adminPricingBar');

        if (adminBadge) adminBadge.classList.remove('hidden');
        if (adminPricingBar) adminPricingBar.style.display = 'block';

        // Suppress paywall unconditionally
        if (paywallModal) {
          paywallModal.style.removeProperty('display');
          paywallModal.style.display = 'none';
          paywallModal.classList.add('hidden');
        }

        // Show dashboard layout
        if (appHeader) appHeader.style.display = 'block';
        if (mainContent) mainContent.style.display = 'block';

        // Background write for Admin role (non-blocking)
        db.collection("users").doc(user.uid).set({
          email: user.email,
          hasPaid: true,
          isAdmin: true
        }, { merge: true }).catch((err) => {
          console.warn("Notice: Admin DB sync note:", err);
        });

        loadUserData();
        if (typeof lucide !== 'undefined') lucide.createIcons();
        return;
      }

      // ==========================================
      // 2. STUDENT SUBSCRIPTION CHECK
      // ==========================================
      const adminBadge = document.getElementById('adminBadge');
      const adminPricingBar = document.getElementById('adminPricingBar');
      if (adminBadge) adminBadge.classList.add('hidden');
      if (adminPricingBar) adminPricingBar.style.display = 'none';

      try {
        const userDoc = await db.collection("users").doc(user.uid).get();
        if (userDoc.exists && userDoc.data().hasPaid === true) {
          if (paywallModal) {
            paywallModal.style.removeProperty('display');
            paywallModal.style.display = 'none';
            paywallModal.classList.add('hidden');
          }
          if (appHeader) appHeader.style.display = 'block';
          if (mainContent) mainContent.style.display = 'block';
          loadUserData();
        } else {
          // Free admission bypass if admin set fee to 0
          if (accessPrice === 0) {
            await db.collection("users").doc(user.uid).set({ hasPaid: true, paidAt: Date.now() }, { merge: true });
            if (paywallModal) {
              paywallModal.style.removeProperty('display');
              paywallModal.style.display = 'none';
              paywallModal.classList.add('hidden');
            }
            if (appHeader) appHeader.style.display = 'block';
            if (mainContent) mainContent.style.display = 'block';
            loadUserData();
            return;
          }

          const paywallPriceDisplay = document.getElementById('paywallPriceDisplay');
          if (paywallPriceDisplay) paywallPriceDisplay.innerText = accessPrice;
          if (appHeader) appHeader.style.display = 'none';
          if (mainContent) mainContent.style.display = 'none';
          if (paywallModal) {
            paywallModal.classList.remove('hidden');
            paywallModal.style.display = 'flex';
          }
        }
      } catch (err) {
        console.error("Student subscription check error:", err);
      }
    } else {
      currentUser = null;
      if (typeof clearCloudListeners === 'function') clearCloudListeners();

      if (authModal) {
        authModal.classList.remove('hidden');
        authModal.style.display = 'flex';
      }
      if (paywallModal) {
        paywallModal.classList.add('hidden');
        paywallModal.style.display = 'none';
      }
      if (appHeader) appHeader.style.display = 'none';
      if (mainContent) mainContent.style.display = 'none';
    }

    if (typeof lucide !== 'undefined') lucide.createIcons();
  });
}

function toggleAuthMode() {
  authIsSignUp = !authIsSignUp;
  const title = document.getElementById('authTitle');
  const subtitle = document.getElementById('authSubtitle');
  const submitBtn = document.getElementById('authSubmitBtn');
  const toggleBtn = document.getElementById('authToggleBtn');
  const togglePrompt = document.getElementById('authTogglePrompt');
  const nameField = document.getElementById('authNameField');

  if (authIsSignUp) {
    if (title) title.innerText = "Create Your Account";
    if (subtitle) subtitle.innerText = "Sign up to track your timetable and calculate safe bunks.";
    if (submitBtn) submitBtn.innerText = "Sign Up";
    if (toggleBtn) toggleBtn.innerText = "Sign In";
    if (togglePrompt) togglePrompt.innerText = "Already have an account?";
    if (nameField) nameField.classList.remove('hidden');
  } else {
    if (title) title.innerText = "Welcome to AttendFlow";
    if (subtitle) subtitle.innerText = "Sign in to sync your timetable and calculate safe bunks.";
    if (submitBtn) submitBtn.innerText = "Sign In";
    if (toggleBtn) toggleBtn.innerText = "Sign Up";
    if (togglePrompt) togglePrompt.innerText = "Don't have an account?";
    if (nameField) nameField.classList.add('hidden');
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const nameInput = document.getElementById('authName');
  const name = nameInput ? nameInput.value.trim() : '';

  try {
    if (authIsSignUp) {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      if (name) {
        await cred.user.updateProfile({ displayName: name });
      }
      const isUserAdmin = (email.toLowerCase().trim() === ADMIN_EMAIL);
      await db.collection("users").doc(cred.user.uid).set({
        email: email,
        displayName: name || email.split('@')[0],
        hasPaid: isUserAdmin,
        createdAt: Date.now()
      });
      showToast("Account created successfully!");
    } else {
      await auth.signInWithEmailAndPassword(email, password);
      showToast("Signed in successfully!");
    }
  } catch (error) {
    console.error("Auth error:", error);
    if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
      alert("Incorrect password or email. If you haven't created this account yet, click 'Sign Up' below.");
    } else if (error.code === 'auth/user-not-found') {
      alert("No account found with this email. Please click 'Sign Up' below to register.");
    } else {
      alert(error.message);
    }
  }
}

async function handleGoogleSignIn() {
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    const cred = await auth.signInWithPopup(provider);
    const user = cred.user;
    const isUserAdmin = (user.email.toLowerCase().trim() === ADMIN_EMAIL);

    const doc = await db.collection("users").doc(user.uid).get();
    if (!doc.exists) {
      await db.collection("users").doc(user.uid).set({
        email: user.email,
        displayName: user.displayName || user.email.split('@')[0],
        hasPaid: isUserAdmin,
        createdAt: Date.now()
      });
    }
    showToast("Signed in with Google!");
  } catch (error) {
    alert(error.message);
  }
}

async function handleForgotPassword() {
  const email = document.getElementById('authEmail').value.trim();
  if (!email) {
    alert("Please enter your email address in the field above first.");
    return;
  }
  try {
    await auth.sendPasswordResetEmail(email);
    alert(`Password reset link sent to ${email}! Please check your inbox.`);
  } catch (err) {
    alert(err.message);
  }
}

function handleSignOut() {
  auth.signOut().then(() => {
    localStorage.clear();
    location.reload();
  });
}

function listenToGlobalConfig() {
  if (!isCloudReady) return;
  db.collection("platform_config").doc("pricing").onSnapshot((doc) => {
    if (doc.exists && doc.data().price !== undefined) {
      accessPrice = Number(doc.data().price);
    } else {
      accessPrice = 99;
    }
    const adminPriceInput = document.getElementById('adminPriceInput');
    const paywallPriceDisplay = document.getElementById('paywallPriceDisplay');
    if (adminPriceInput) adminPriceInput.value = accessPrice;
    if (paywallPriceDisplay) paywallPriceDisplay.innerText = accessPrice;
  }, (err) => {
    console.warn("Pricing listener notice:", err);
  });
}

async function saveAdminPrice() {
  if (!isAdmin) return;
  const price = parseFloat(document.getElementById('adminPriceInput').value);
  if (isNaN(price) || price < 0) {
    alert("Please enter a valid price amount.");
    return;
  }
  try {
    await db.collection("platform_config").doc("pricing").set({
      price: price,
      updatedAt: Date.now()
    }, { merge: true });
    showToast(`Access fee updated to ₹${price}`);
  } catch (err) {
    alert("Failed to update price: " + err.message);
  }
}

function initiatePayment() {
  if (!currentUser) return;

  if (typeof Razorpay === 'undefined') {
    alert("Razorpay payment gateway failed to load. Please disable ad-blockers and reload.");
    return;
  }

  const options = {
    key: RAZORPAY_KEY_ID,
    amount: Math.round(accessPrice * 100),
    currency: "INR",
    name: "AttendFlow Premium",
    description: "One-Time Access Fee for Student Attendance Dashboard",
    image: "https://placehold.co/128x128/4f46e5/ffffff?text=AttendFlow",
    prefill: {
      name: currentUser.displayName || "",
      email: currentUser.email || ""
    },
    theme: { color: "#4f46e5" },
    handler: async function (res) {
      try {
        await db.collection("users").doc(currentUser.uid).set({
          hasPaid: true,
          paymentId: res.razorpay_payment_id,
          paidAmount: accessPrice,
          paidAt: Date.now()
        }, { merge: true });

        const paywallModal = document.getElementById('paywallModal');
        const appHeader = document.getElementById('appHeader');
        const mainContent = document.getElementById('appMainContent');

        if (paywallModal) {
          paywallModal.style.removeProperty('display');
          paywallModal.style.display = 'none';
          paywallModal.classList.add('hidden');
        }
        if (appHeader) appHeader.style.display = 'block';
        if (mainContent) mainContent.style.display = 'block';

        showToast("Payment Successful! Welcome to AttendFlow.");
        loadUserData();
      } catch (err) {
        console.error("Payment storage error:", err);
        showToast("Payment confirmed. Refreshing session...");
        setTimeout(() => location.reload(), 1500);
      }
    },
    modal: {
      ondismiss: function () {
        showToast("Payment window closed.");
      }
    }
  };

  const rzp = new Razorpay(options);
  rzp.open();
}