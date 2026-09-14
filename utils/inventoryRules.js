// utils/inventoryRules.js — Inventory Alert & Expiry Intelligence Rules

(function (global) {
  // 1. Tiered Low-Stock Safety Thresholds
  const STOCK_THRESHOLDS = {
    HIGH_DEMAND: 50,   // Fast-moving / common (e.g. Paracetamol, Dolo, Antacids, Antibiotics)
    MEDIUM_DEMAND: 20, // Regular maintenance (e.g. BP, Diabetes, standard tablets)
    LOW_DEMAND: 5,     // Specialist / expensive / rare (e.g. Chemotherapy, rare injectables)
    DEFAULT: 20
  };

  // Common keywords for automatic demand classification
  const COMMON_HIGH_DEMAND_KEYWORDS = [
    'paracetamol', 'dolo', 'crocin', 'pan', 'pantop', 'omee', 'cetri', 'cetirizine',
    'amoxicillin', 'augmentin', 'azithro', 'azithromycin', 'ors', 'cough', 'vicks',
    'calpol', 'combiflam', 'allegra', 'cheston', 'metrogyl'
  ];

  const RARE_LOW_DEMAND_KEYWORDS = [
    'inj', 'injection', 'vial', 'chemo', 'oncology', 'infusion', 'vaccine', 'recombinant'
  ];

  /**
   * Infers demand tier from medicine name if not explicitly set
   */
  function inferDemandTier(medicineName) {
    if (!medicineName) return 'MEDIUM_DEMAND';
    const lower = medicineName.toLowerCase();

    if (COMMON_HIGH_DEMAND_KEYWORDS.some(k => lower.includes(k))) {
      return 'HIGH_DEMAND';
    }
    if (RARE_LOW_DEMAND_KEYWORDS.some(k => lower.includes(k))) {
      return 'LOW_DEMAND';
    }
    return 'MEDIUM_DEMAND';
  }

  /**
   * Evaluates if a medicine is running low on stock
   */
  function checkStockAlert(medicineName, totalQuantity, explicitTier = null) {
    const tier = explicitTier || inferDemandTier(medicineName);
    const threshold = STOCK_THRESHOLDS[tier] || STOCK_THRESHOLDS.DEFAULT;
    const qty = Number(totalQuantity || 0);

    return {
      isLowStock: qty <= threshold,
      threshold: threshold,
      tier: tier,
      tierLabel: tier === 'HIGH_DEMAND' ? 'High Demand (Common)' : (tier === 'LOW_DEMAND' ? 'Low Demand (Specialist)' : 'Standard Demand'),
      unitsRemaining: qty,
      deficit: Math.max(0, threshold - qty)
    };
  }

  /**
   * Evaluates expiry urgency (FEFO Priority)
   */
  function checkExpiryStatus(expiryDateStr) {
    if (!expiryDateStr) return { status: 'UNKNOWN', label: 'No date', daysLeft: 9999 };

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
    }

    const expDate = new Date(expYear, expMonth, expDay);
    const diff = expDate - now;
    const daysLeft = Math.ceil(diff / (1000 * 60 * 60 * 24));

    if (daysLeft <= 0) {
      return { status: 'EXPIRED', daysLeft, class: 'critical', label: 'Expired (Remove Immediately)' };
    } else if (daysLeft <= 30) {
      return { status: 'CRITICAL', daysLeft, class: 'critical', label: `Sell First (Expires in ${daysLeft}d)` };
    } else if (daysLeft <= 60) {
      return { status: 'WARNING', daysLeft, class: 'warning', label: `Expiring Soon (${daysLeft}d left)` };
    } else if (daysLeft <= 90) {
      return { status: 'WATCHLIST', daysLeft, class: 'watchlist', label: `Watchlist (${daysLeft}d left)` };
    } else {
      return { status: 'SAFE', daysLeft, class: 'safe', label: `Safe (${daysLeft}d left)` };
    }
  }

  // Expose globally to window
  global.InventoryRules = {
    STOCK_THRESHOLDS,
    inferDemandTier,
    checkStockAlert,
    checkExpiryStatus
  };
})(window);