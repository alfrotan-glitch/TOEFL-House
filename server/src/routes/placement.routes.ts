/**
 * Placement Assessment Engine — route aggregator.
 * Mounts the attempt lifecycle router and the test-bank/content router under
 * the same paths the ERP has always used (/api/placement). The business logic
 * lives in src/core/placement/* (policy, timing, scoring, decision, reporting)
 * and in the two dedicated routers.
 */
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { placementAttemptRouter } from './placement-attempt.routes.js';
import { placementTestBankRouter } from './placement-test-bank.routes.js';

const router = Router();
router.use(authenticate);

router.use(placementAttemptRouter);
router.use(placementTestBankRouter);

export default router;
