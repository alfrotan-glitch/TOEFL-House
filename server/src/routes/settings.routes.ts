import { Router } from 'express';
import { authenticate, authorize, requirePermission } from '../middleware/auth.js';
import { ah } from '../middleware/errorHandler.js';
import { getNumberSetting, setSetting } from '../utils/settings.js';
import { getFinanceAccount } from '../utils/financeAccounts.js';
import { SYSTEM_DEFAULTS } from '../core/configuration/policy-catalog.js';

export const systemSettingsRouter = Router();
systemSettingsRouter.use(authenticate);

// ── Architecture Note: Global Fallback Defaults ────────────────────────────
// These values act as GLOBAL FALLBACK defaults.
// The primary source of truth for fees is now the Rule Engine (Business Rules).
// If a branch-specific rule exists in the Rule Engine, it overrides these values.
// These settings exist so the system has a baseline if no rule is configured.

/**
 * Fee configuration is owned by the Academic Control Center (branch academic profile).
 * System Administration intentionally does not duplicate fee-management controls.
 */
/**
 * Operational settings snapshot for Settings UI.
 * Balances are organization-level cash settings (see Finance module notes).
 */
systemSettingsRouter.get(
  '/system',
  authorize('owner'),
  ah(async (req, res) => {
    res.json({
      finance: {
        ...(req.user?.branchId ? (() => { const a = getFinanceAccount('branch', req.user.branchId); return { mainAccountBalance: a.mainBalance, savingBalance: a.savingBalance }; })() : {}) ,
        dailySavingPercent: getNumberSetting('daily_saving_percent', SYSTEM_DEFAULTS.dailySavingPercent),
        expenseAutoApproveThreshold: getNumberSetting('expense_auto_approve_threshold', SYSTEM_DEFAULTS.expenseAutoApproveThreshold),
        invoiceDueDays: getNumberSetting('invoice_due_days', SYSTEM_DEFAULTS.invoiceDueDays),
      },
    });
  })
);

export default systemSettingsRouter;