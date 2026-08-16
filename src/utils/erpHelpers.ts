import { Student } from '../types';
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
