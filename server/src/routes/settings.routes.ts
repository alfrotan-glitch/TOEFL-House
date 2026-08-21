import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, requireGlobalOwner } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { getNumberSetting } from '../utils/settings.js';
import { getFinanceAccount } from '../utils/financeAccounts.js';
import { SYSTEM_DEFAULTS } from '../core/configuration/policy-catalog.js';

export const systemSettingsRouter = Router();
systemSettingsRouter.use(authenticate);

// These persisted values override SYSTEM_DEFAULTS for their owning finance and
// invoice services. Fees are deliberately absent: fee configuration belongs to
// the Academic Control Center branch profile, not this system snapshot or the
// generic Rule Engine.

/**
 * Organization-owner operational settings snapshot for the Settings UI.
 * Cash balances remain branch account facts; the three numeric settings are
 * consumed by their finance/invoice owners and are not redefined here.
 */
systemSettingsRouter.get(
  '/system',
  requireGlobalOwner,
  ah(async (req, res) => {
    const requestedBranchId = req.query.branchId;
    if (requestedBranchId !== undefined && typeof requestedBranchId !== 'string') {
      throw new HttpError(400, 'branchId must identify one branch.');
    }
    const branchId = requestedBranchId || req.user?.branchId;
    let cash: { branchId: string; mainAccountBalance: number; savingBalance: number } | undefined;
    if (branchId) {
      if (!db.prepare('SELECT id FROM branches WHERE id = ?').get(branchId)) {
        throw new HttpError(404, 'Branch not found.');
      }
      const account = getFinanceAccount('branch', branchId);
      cash = {
        branchId,
        mainAccountBalance: account.mainBalance,
        savingBalance: account.savingBalance,
      };
    }

    res.json({
      finance: {
        ...cash,
        dailySavingPercent: getNumberSetting('daily_saving_percent', SYSTEM_DEFAULTS.dailySavingPercent),
        expenseAutoApproveThreshold: getNumberSetting('expense_auto_approve_threshold', SYSTEM_DEFAULTS.expenseAutoApproveThreshold),
        invoiceDueDays: getNumberSetting('invoice_due_days', SYSTEM_DEFAULTS.invoiceDueDays),
      },
    });
  })
);

export default systemSettingsRouter;