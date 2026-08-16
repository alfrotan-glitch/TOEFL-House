import { Student, Payment } from '../types';
import { formatAFN as formatAFNCore } from './format';

/** Re-export single currency formatter (Latin numerals). */
export const formatAFN = formatAFNCore;


export const validatePhone = (phone: string): boolean => {
  const cleanPhone = phone.trim();
  return /^(07|\+937)\d{8}$/.test(cleanPhone);
};

export const validateEmail = (email: string): boolean => {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
};

export const calculateTotalTuitionRaw = (student: Student): number => {
  return student.semesters?.reduce((acc, s) => acc + s.feeAmount, 0) || 0;
};

export const calculateTotalTuition = (student: Student): number => {
  const raw = calculateTotalTuitionRaw(student);
  const discount = student.discountPercent || 0;
  return Math.max(0, raw - Math.round((raw * discount) / 100));
};

/**
 * @deprecated Counts only category==='fee', so it ignores installments AND
 * refunds — it will overstate what a refunded student has paid. Use
 * `computeStudentBalance` from utils/studentBalance, which is the single
 * authoritative definition shared with the server. Kept only so any straggling
 * import keeps compiling; it has no callers.
 */
export const calculateTotalPaidFees = (studentId: string, payments: Payment[]): number => {
  return payments
    .filter((p) => p.studentId === studentId && p.category === 'fee')
    .reduce((acc, p) => acc + p.amount, 0);
};

/** @deprecated Use `computeStudentBalance(...).outstanding`. Ignores refunds. */
export const calculateRemainingDebt = (student: Student, payments: Payment[]): number => {
  return calculateTotalTuition(student) - calculateTotalPaidFees(student.id, payments);
};

/** @deprecated Use `computeStudentBalance(...).paidPercentage`. Ignores refunds. */
export const calculatePaidPercentage = (student: Student, payments: Payment[]): number => {
  const totalTuition = calculateTotalTuition(student);
  if (totalTuition <= 0) return 100;
  return Math.round((calculateTotalPaidFees(student.id, payments) / totalTuition) * 100);
};

export const generateInstallments = (remainingDebt: number, numInstallments: number): number[] => {
  if (remainingDebt <= 0 || numInstallments <= 0) return [];
  const share = Math.round(remainingDebt / numInstallments);
  const arr = Array(numInstallments).fill(share);
  if (numInstallments > 1) {
    arr[numInstallments - 1] = remainingDebt - share * (numInstallments - 1);
  }
  return arr;
};

export const formatDateDisplay = (dateStr: string): string => {
  if (!dateStr) return 'Not set';
  return dateStr;
};
