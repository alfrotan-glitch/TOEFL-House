/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import {Building2, Database, Edit, Trash2, Plus, X, User, HeartHandshake, Tag, KeyRound, UserPlus, CheckCircle2, MapPin, ShieldCheck} from 'lucide-react';
import PositionsPanel, { PositionRow, PermissionDef } from './PositionsPanel';
import UserPositionsPanel, { UserLite } from './UserPositionsPanel';
import {SystemSettings, Branch, Campus, Partner, UserRole} from '../../types';
import {ALL_ROLES, getRoleLabel} from '../../config/roles';

interface UserAccount {
  id: string; username: string; fullName: string; email: string | null; role: string;
  branchId: string; isActive: boolean; mustChangePassword: boolean; createdAt: string; lastLoginAt: string | null;
}

type OrgEntityPayload = {
  name: string;
  code: string;
  address?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  description?: string;
  isActive?: boolean;
  campusId?: string;
};

interface SettingsViewProps {
  settings: SystemSettings;
  partners: Partner[];
  addPartner: (fullName: string, phone: string, email: string, sharePercent: number, roleDescription: string) => Promise<void>;
  editPartner: (id: string, fullName: string, phone: string, email: string, sharePercent: number, roleDescription: string) => Promise<void>;
  deletePartner: (id: string) => Promise<void>;
  activeRole: UserRole;
  onOpenAcademicSetup: () => void;
  listUserAccounts: () => Promise<UserAccount[]>;
  createUserAccount: (params: {
    username: string; tempPassword: string; fullName: string; email?: string;
    role: string; branchId: string;
  }) => Promise<void>;
  resetUserPassword: (userId: string, tempPassword: string) => Promise<void>;
  createCampus: (payload: OrgEntityPayload) => Promise<void>;
  updateCampus: (id: string, payload: Partial<OrgEntityPayload>) => Promise<void>;
  deactivateCampus: (id: string) => Promise<void>;
  deleteCampus: (id: string) => Promise<void>;
  createBranch: (payload: OrgEntityPayload & { campusId: string; address: string }) => Promise<void>;
  updateBranch: (id: string, payload: Partial<OrgEntityPayload>) => Promise<void>;
  deactivateBranch: (id: string) => Promise<void>;
  deleteBranch: (id: string) => Promise<void>;
  // Positions & access (owner-only)
  listPositions: () => Promise<PositionRow[]>;
  listPermissionCatalog: () => Promise<PermissionDef[]>;
  createPosition: (params: { name: string; description?: string; permissions?: { permissionId: string; scope?: string }[] }) => Promise<unknown>;
  updatePosition: (roleId: string, updates: { name?: string; description?: string; isActive?: boolean }) => Promise<void>;
  updatePositionPermissions: (roleId: string, permissions: { permissionId: string; scope?: string }[]) => Promise<void>;
  listUserPositions: (userId: string) => Promise<import('./UserPositionsPanel').UserPositionRow[]>;
  assignUserPosition: (userId: string, params: { roleId: string; scopeType?: string; scopeId?: string | null }) => Promise<unknown>;
  removeUserPosition: (userId: string, assignmentId: string) => Promise<unknown>;
  viewEffectivePermissions: (userId: string) => Promise<import('./UserPositionsPanel').EffectivePerm[]>;
}

export default function SettingsView({
  settings,
  partners = [],
  addPartner,
  editPartner,
  deletePartner,
  activeRole,
  onOpenAcademicSetup,
  listUserAccounts,
  createUserAccount,
  resetUserPassword,
  createCampus,
  updateCampus,
  deactivateCampus,
  deleteCampus,
  createBranch,
  updateBranch,
  deactivateBranch,
  deleteBranch,
  listPositions,
  listPermissionCatalog,
  createPosition,
  updatePosition,
  updatePositionPermissions,
  listUserPositions,
  assignUserPosition,
  removeUserPosition,
  viewEffectivePermissions,
}: SettingsViewProps) {

  // Organization hierarchy form state
  const campuses: Campus[] = settings.campuses || [];
  const branchesList: Branch[] = settings.branches || [];
  const canConfigureOrg = activeRole === 'owner' || activeRole === 'manager';
  const [campusForm, setCampusForm] = useState({
    name: '', code: '', address: '', postalCode: '', phone: '', email: '', description: '', isActive: true,
  });
  const [branchForm, setBranchForm] = useState({
    name: '', code: '', campusId: '', address: '', postalCode: '', phone: '', email: '', description: '', isActive: true,
  });
  const [editingCampusId, setEditingCampusId] = useState<string | null>(null);
  const [editingBranchId, setEditingBranchId] = useState<string | null>(null);
  const [orgSaving, setOrgSaving] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [expandedCampusId, setExpandedCampusId] = useState<string | null>(null);

  const resetCampusForm = () => {
    setCampusForm({ name: '', code: '', address: '', postalCode: '', phone: '', email: '', description: '', isActive: true });
    setEditingCampusId(null);
  };
  const resetBranchForm = () => {
    setBranchForm({ name: '', code: '', campusId: campuses[0]?.id || '', address: '', postalCode: '', phone: '', email: '', description: '', isActive: true });
    setEditingBranchId(null);
  };

  const handleSaveCampus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canConfigureOrg) return;
    setOrgSaving(true);
    setOrgError(null);
    try {
      if (editingCampusId && editingCampusId !== 'new') {
        await updateCampus(editingCampusId, campusForm);
      } else {
        await createCampus(campusForm);
      }
      resetCampusForm();
    } catch (err) {
      setOrgError(err instanceof Error ? err.message : 'Failed to save campus.');
    } finally {
      setOrgSaving(false);
    }
  };

  const handleSaveBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canConfigureOrg) return;
    if (!branchForm.campusId) {
      setOrgError('Campus is required for a branch.');
      return;
    }
    if (!branchForm.address.trim()) {
      setOrgError('Branch address is required.');
      return;
    }
    setOrgSaving(true);
    setOrgError(null);
    try {
      if (editingBranchId && editingBranchId !== 'new') {
        await updateBranch(editingBranchId, branchForm);
      } else {
        await createBranch({ ...branchForm, campusId: branchForm.campusId, address: branchForm.address });
      }
      resetBranchForm();
    } catch (err) {
      setOrgError(err instanceof Error ? err.message : 'Failed to save branch.');
    } finally {
      setOrgSaving(false);
    }
  };

  const startEditCampus = (c: Campus) => {
    setEditingCampusId(c.id);
    setCampusForm({
      name: c.name,
      code: c.code,
      address: c.address || '',
      postalCode: c.postalCode || '',
      phone: c.phone || '',
      email: c.email || '',
      description: c.description || '',
      isActive: c.isActive,
    });
  };

  const startEditBranch = (b: Branch) => {
    setEditingBranchId(b.id);
    setBranchForm({
      name: b.name,
      code: b.code || '',
      campusId: b.campusId || campuses[0]?.id || '',
      address: b.address || b.location || '',
      postalCode: b.postalCode || '',
      phone: b.phone || '',
      email: b.email || '',
      description: b.description || '',
      isActive: b.isActive !== false,
    });
  };

  // User account management state
  const [userAccounts, setUserAccounts] = useState<UserAccount[]>([]);
  const [showAddUserForm, setShowAddUserForm] = useState<boolean>(false);
  const [newUsername, setNewUsername] = useState<string>('');
  const [newTempPassword, setNewTempPassword] = useState<string>('');
  const [newUserFullName, setNewUserFullName] = useState<string>('');
  const [newUserRole, setNewUserRole] = useState<string>('registrar');
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);
  const [resetTempPassword, setResetTempPassword] = useState<string>('');

  const loadUserAccounts = useCallback(() => {
    listUserAccounts().then(setUserAccounts).catch(() => {});
  }, [listUserAccounts]);

  useEffect(() => {
    if (activeRole === 'owner') loadUserAccounts();
  }, [activeRole, loadUserAccounts]);


  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername || !newTempPassword || !newUserFullName) {
      alert('Username, temporary password, and full name are required.');
      return;
    }
    if (newTempPassword.length < 12) {
      alert('Temporary password must be at least 12 characters.');
      return;
    }
    try {
      await createUserAccount({
        username: newUsername, tempPassword: newTempPassword, fullName: newUserFullName,
        role: newUserRole, branchId: settings.currentBranchId,
      });
      setNewUsername('');
      setNewTempPassword('');
      setNewUserFullName('');
      setNewUserRole('registrar');
      setShowAddUserForm(false);
      loadUserAccounts();
      alert('User account created. Share the temporary password with the user securely.');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create user account.');
    }
  };

  const handleResetPassword = async (userId: string) => {
    if (!resetTempPassword || resetTempPassword.length < 12) {
      alert('New temporary password must be at least 12 characters.');
      return;
    }
    try {
      await resetUserPassword(userId, resetTempPassword);
      setResettingUserId(null);
      setResetTempPassword('');
      alert('Password reset. Share the new temporary password with the user securely.');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Password reset failed.');
    }
  };

  // Form states for adding/editing partner
  const [editingPartnerId, setEditingPartnerId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState<boolean>(false);
  const [partnerError, setPartnerError] = useState<string | null>(null);
  const [partnerName, setPartnerName] = useState<string>('');
  const [partnerPhone, setPartnerPhone] = useState<string>('');
  const [partnerEmail, setPartnerEmail] = useState<string>('');
  const [partnerShare, setPartnerShare] = useState<number>(0);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [permissionCatalog, setPermissionCatalog] = useState<PermissionDef[]>([]);
  const [positionError, setPositionError] = useState<string | null>(null);

  const loadPositions = useCallback(async () => {
    try {
      const [pos, perms] = await Promise.all([listPositions(), listPermissionCatalog()]);
      setPositions(pos);
      setPermissionCatalog(perms);
      setPositionError(null);
    } catch (err) {
      setPositionError(err instanceof Error ? err.message : 'Could not load positions.');
    }
  }, [listPositions, listPermissionCatalog]);

  const [partnerRole, setPartnerRole] = useState<string>('');

  const handleStartEdit = (p: Partner) => {
    setEditingPartnerId(p.id);
    setPartnerName(p.fullName);
    setPartnerPhone(p.phone);
    setPartnerEmail(p.email);
    setPartnerShare(p.sharePercent);
    setPartnerRole(p.roleDescription);
  };

  const handleCancelEdit = () => {
    setEditingPartnerId(null);
    clearForm();
  };

  const clearForm = () => {
    setPartnerName('');
    setPartnerPhone('');
    setPartnerEmail('');
    setPartnerShare(0);
    setPartnerRole('');
    setShowAddForm(false);
  };

  const handleAddPartnerSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const totalCurrentShares = partners.reduce((sum, p) => sum + p.sharePercent, 0);
    if (totalCurrentShares + partnerShare > 100) {
      alert(`Error: total partner shares cannot exceed 100% (currently distributed: ${totalCurrentShares}%).`);
      return;
    }
    try {
      await addPartner(partnerName, partnerPhone, partnerEmail, partnerShare, partnerRole);
      setPartnerError(null);
      clearForm();
    } catch (err) {
      setPartnerError(err instanceof Error ? err.message : 'Could not add partner.');
    }
  };

  const handleEditPartnerSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPartnerId) return;
    const totalCurrentShares = partners
      .filter(p => p.id !== editingPartnerId)
      .reduce((sum, p) => sum + p.sharePercent, 0);

    if (totalCurrentShares + partnerShare > 100) {
      alert(`Error: total partner shares cannot exceed 100% (other partners already hold: ${totalCurrentShares}%).`);
      return;
    }
    try {
      await editPartner(editingPartnerId, partnerName, partnerPhone, partnerEmail, partnerShare, partnerRole);
      setPartnerError(null);
      setEditingPartnerId(null);
      clearForm();
    } catch (err) {
      setPartnerError(err instanceof Error ? err.message : 'Could not update partner.');
    }
  };

  const handleDeletePartner = async (id: string, name: string) => {
    if (confirm(`Are you sure you want to remove partner/owner "${name}" from the system?`)) {
      try {
        await deletePartner(id);
        setPartnerError(null);
      } catch (err) {
        setPartnerError(err instanceof Error ? err.message : 'Could not remove partner.');
      }
    }
  };

  const totalShares = partners.reduce((sum, p) => sum + p.sharePercent, 0);
  const isOwner = activeRole === 'owner';

  return (
    <div className="space-y-6 font-sans text-left" dir="ltr" id="settings-view-root">
      {partnerError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs font-semibold text-rose-700" role="alert">
          {partnerError}
        </div>
      )}
      {/* Header */}
      <div className="border-b border-slate-200 pb-4">
        <h2 className="text-xl font-extrabold text-slate-900">Core settings & branch configuration</h2>
        <p className="text-xs text-slate-500 mt-1">Organization, access, and system administration</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Side: General and savings */}
        <div className="lg:col-span-6 space-y-6">
          <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-5 shadow-sm space-y-2">
            <p className="text-sm font-extrabold text-slate-900">Finance policy lives in Finance Desk</p>
            <p className="text-xs text-slate-600 leading-relaxed">Cash, savings, expense approval thresholds, invoices, and month-end controls are owned by Finance Desk. This area intentionally exposes no duplicate finance configuration.</p>
          </div>

          <div className="bg-gradient-to-br from-indigo-600 to-slate-950 text-white rounded-2xl p-5 shadow-sm space-y-4">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-xl bg-white/10 border border-white/10 flex items-center justify-center shrink-0">
                <Tag className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-extrabold">Academic policy is managed in one place</h3>
                <p className="mt-1 text-xs text-white/70 leading-relaxed">Programs, levels, fees, pass marks, rooms, time slots and academic terms live in the Academic Control Center. System Administration intentionally avoids duplicating those controls.</p>
              </div>
            </div>
            <button type="button" onClick={onOpenAcademicSetup} className="w-full rounded-xl bg-white text-slate-900 px-4 py-2.5 text-xs font-extrabold hover:bg-slate-100 transition-colors">Open Academic Control Center</button>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-3">
            <div className="flex items-center gap-2">
              <Database className="w-5 h-5 text-indigo-600" />
              <h3 className="text-sm font-extrabold text-slate-900">Backup integration</h3>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">Backup is deployment-managed. This screen does not claim a backup succeeded unless a configured storage target confirms it.</p>
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">Backup target is not configured.</div>
          </div>
        </div>

        {/* Organization → Campus → Branch configuration (nested) */}
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-5">
          <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-1.5 border-b border-slate-50 pb-2.5">
            <Building2 className="w-5 h-5 text-indigo-600" />
            Organization structure
          </h3>
          <div className="bg-indigo-50/40 border border-indigo-100 rounded-xl p-3 text-xs space-y-1">
            <p className="font-extrabold text-slate-900">Organization</p>
            <p className="text-slate-700 font-bold">{settings.organization?.name || 'The TOEFL House'}</p>
            <p className="text-slate-500">Hierarchy: Organization → Campus → Branch. Branches always belong to one campus.</p>
          </div>

          {orgError && (
            <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{orgError}</div>
          )}

          <div className="flex items-center justify-between">
            <h4 className="text-xs font-extrabold text-slate-800 uppercase tracking-wide">Campuses &amp; branches</h4>
            {canConfigureOrg && (
              <div className="flex gap-2">
                <button type="button" onClick={() => { resetCampusForm(); setEditingCampusId('new'); setEditingBranchId(null); }} className="text-[11px] font-bold text-indigo-600 hover:underline flex items-center gap-1">
                  <Plus className="w-3.5 h-3.5" /> Add campus
                </button>
              </div>
            )}
          </div>

          {(editingCampusId === 'new' || (editingCampusId && editingCampusId !== 'new')) && canConfigureOrg && editingCampusId && (
              <form onSubmit={handleSaveCampus} className="bg-white border border-indigo-100 rounded-xl p-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <p className="sm:col-span-2 font-extrabold text-slate-700">{editingCampusId === 'new' ? 'New campus' : 'Edit campus'}</p>
                <input required placeholder="Campus name" value={campusForm.name} onChange={(e) => setCampusForm({ ...campusForm, name: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5" />
                <input required placeholder="Code (e.g. KBL)" value={campusForm.code} onChange={(e) => setCampusForm({ ...campusForm, code: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 font-mono" />
                <input placeholder="Address" value={campusForm.address} onChange={(e) => setCampusForm({ ...campusForm, address: e.target.value })} className="sm:col-span-2 border border-slate-200 rounded-lg px-2 py-1.5" />
                <input placeholder="Postal code" value={campusForm.postalCode} onChange={(e) => setCampusForm({ ...campusForm, postalCode: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5" />
                <input placeholder="Phone" value={campusForm.phone} onChange={(e) => setCampusForm({ ...campusForm, phone: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5" />
                <input placeholder="Email" value={campusForm.email} onChange={(e) => setCampusForm({ ...campusForm, email: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5" />
                <input placeholder="Description" value={campusForm.description} onChange={(e) => setCampusForm({ ...campusForm, description: e.target.value })} className="sm:col-span-2 border border-slate-200 rounded-lg px-2 py-1.5" />
                <label className="flex items-center gap-2 font-bold text-slate-600">
                  <input type="checkbox" checked={campusForm.isActive} onChange={(e) => setCampusForm({ ...campusForm, isActive: e.target.checked })} />
                  Active
                </label>
                <div className="flex gap-2 justify-end sm:col-span-2">
                  <button type="button" onClick={resetCampusForm} className="px-3 py-1.5 rounded-lg border border-slate-200 font-bold">Cancel</button>
                  <button type="submit" disabled={orgSaving} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold disabled:opacity-50">{orgSaving ? 'Saving…' : editingCampusId === 'new' ? 'Create campus' : 'Save campus'}</button>
                </div>
              </form>
          )}

          <div className="space-y-3 max-h-[520px] overflow-y-auto pr-0.5">
            {campuses.length === 0 ? (
              <p className="text-xs text-slate-400 italic">No campuses configured.</p>
            ) : campuses.map((c) => {
              const campusBranches = branchesList.filter((b) => b.campusId === c.id);
              const open = expandedCampusId === c.id || (expandedCampusId === null && campuses[0]?.id === c.id);
              return (
                <div key={c.id} className={`border rounded-2xl overflow-hidden ${c.isActive ? 'border-slate-200' : 'border-slate-100 opacity-80'}`}>
                  <button
                    type="button"
                    onClick={() => setExpandedCampusId(open ? '' : c.id)}
                    className="w-full text-left bg-slate-50 hover:bg-slate-100/80 px-3.5 py-3 flex items-start justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <p className="font-extrabold text-slate-900 text-xs">
                        {c.name}{' '}
                        <span className="font-mono text-indigo-600 font-bold">({c.code})</span>
                      </p>
                      <p className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-1">
                        <MapPin className="w-3 h-3 shrink-0" />
                        <span className="truncate">{c.address || '—'}</span>
                      </p>
                      <p className="text-[10px] mt-1.5 flex flex-wrap gap-1.5 items-center">
                        <span className={`px-1.5 py-0.5 rounded-full font-bold border ${c.isActive ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
                          {c.isActive ? 'Active' : 'Inactive'}
                        </span>
                        <span className="px-1.5 py-0.5 rounded-full font-bold border border-indigo-100 bg-indigo-50 text-indigo-700">
                          {campusBranches.length} branch{campusBranches.length === 1 ? '' : 'es'}
                          {typeof c.activeBranchCount === 'number' ? ` · ${c.activeBranchCount} active` : ''}
                        </span>
                        {c.postalCode ? <span className="text-slate-400">Postal: {c.postalCode}</span> : null}
                      </p>
                    </div>
                    <span className="text-[10px] font-bold text-slate-400 shrink-0 mt-0.5">{open ? '▾' : '▸'}</span>
                  </button>

                  {open && (
                    <div className="px-3.5 py-3 space-y-2 bg-white border-t border-slate-100">
                      {canConfigureOrg && (
                        <div className="flex flex-wrap gap-2 justify-end">
                          <button type="button" onClick={() => startEditCampus(c)} className="text-[10px] font-bold text-indigo-600 hover:underline">Edit campus</button>
                          {c.isActive && (
                            <button
                              type="button"
                              onClick={async () => {
                                if (!confirm(`Deactivate campus "${c.name}" and all of its branches?`)) return;
                                setOrgError(null);
                                try { await deactivateCampus(c.id); } catch (err) { setOrgError(err instanceof Error ? err.message : 'Deactivate failed.'); }
                              }}
                              className="text-[10px] font-bold text-amber-700 hover:underline"
                            >
                              Deactivate
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={async () => {
                              if (!confirm(`Permanently delete campus "${c.name}"? Only allowed when no operational data exists under its branches.`)) return;
                              setOrgError(null);
                              try { await deleteCampus(c.id); } catch (err) { setOrgError(err instanceof Error ? err.message : 'Delete failed.'); }
                            }}
                            className="text-[10px] font-bold text-rose-600 hover:underline"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              resetBranchForm();
                              setBranchForm((prev) => ({ ...prev, campusId: c.id }));
                              setEditingBranchId('new');
                              setEditingCampusId(null);
                            }}
                            className="text-[10px] font-bold text-emerald-700 hover:underline flex items-center gap-0.5"
                          >
                            <Plus className="w-3 h-3" /> Add branch here
                          </button>
                        </div>
                      )}

                      {campusBranches.length === 0 ? (
                        <p className="text-[11px] text-slate-400 italic py-2">No branches under this campus yet.</p>
                      ) : (
                        <div className="space-y-2">
                          {campusBranches.map((b) => (
                            <div key={b.id} className="border border-slate-100 rounded-xl p-3 text-xs flex justify-between gap-2 bg-slate-50/60">
                              <div className="min-w-0">
                                <p className="font-bold text-slate-900">
                                  {b.name}{' '}
                                  <span className="font-mono text-indigo-600">({b.code || '—'})</span>
                                </p>
                                <p className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-1">
                                  <MapPin className="w-3 h-3 shrink-0" />
                                  <span className="truncate">{b.address || b.location || '—'}</span>
                                </p>
                                <p className="text-[10px] mt-1 flex flex-wrap gap-1.5 items-center">
                                  <span className={`px-1.5 py-0.5 rounded-full font-bold border ${b.isActive !== false ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
                                    {b.isActive !== false ? 'Active' : 'Inactive'}
                                  </span>
                                  {b.postalCode ? <span className="text-slate-400">Postal: {b.postalCode}</span> : null}
                                </p>
                              </div>
                              {canConfigureOrg && (
                                <div className="flex flex-col gap-1 shrink-0 items-end">
                                  <button type="button" onClick={() => startEditBranch(b)} className="text-[10px] font-bold text-indigo-600 hover:underline">Edit</button>
                                  {b.isActive !== false && (
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        if (!confirm(`Deactivate branch "${b.name}"?`)) return;
                                        setOrgError(null);
                                        try { await deactivateBranch(b.id); } catch (err) { setOrgError(err instanceof Error ? err.message : 'Deactivate failed.'); }
                                      }}
                                      className="text-[10px] font-bold text-amber-700 hover:underline"
                                    >
                                      Deactivate
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      if (!confirm(`Permanently delete branch "${b.name}"? Only allowed when no operational data references this branch.`)) return;
                                      setOrgError(null);
                                      try { await deleteBranch(b.id); } catch (err) { setOrgError(err instanceof Error ? err.message : 'Delete failed.'); }
                                    }}
                                    className="text-[10px] font-bold text-rose-600 hover:underline"
                                  >
                                    Delete
                                  </button>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {(() => {
                        const showBranchForm =
                          canConfigureOrg &&
                          !!editingBranchId &&
                          ((editingBranchId === 'new' && branchForm.campusId === c.id) ||
                            (editingBranchId !== 'new' &&
                              campusBranches.some((x) => x.id === editingBranchId)));
                        if (!showBranchForm) return null;
                        return (
                          <form onSubmit={handleSaveBranch} className="bg-white border border-emerald-100 rounded-xl p-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs mt-2">
                            <p className="sm:col-span-2 font-extrabold text-slate-700">{editingBranchId === 'new' ? `New branch under ${c.name}` : 'Edit branch'}</p>
                            <input required placeholder="Branch name" value={branchForm.name} onChange={(e) => setBranchForm({ ...branchForm, name: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5" />
                            <input required placeholder="Unique code (e.g. TH-MB-001)" value={branchForm.code} onChange={(e) => setBranchForm({ ...branchForm, code: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 font-mono" />
                            <select required value={branchForm.campusId} onChange={(e) => setBranchForm({ ...branchForm, campusId: e.target.value })} className="sm:col-span-2 border border-slate-200 rounded-lg px-2 py-1.5">
                              <option value="">Select campus…</option>
                              {campuses.filter((x) => x.isActive || x.id === branchForm.campusId).map((x) => (
                                <option key={x.id} value={x.id}>{x.name} ({x.code})</option>
                              ))}
                            </select>
                            <input required placeholder="Address" value={branchForm.address} onChange={(e) => setBranchForm({ ...branchForm, address: e.target.value })} className="sm:col-span-2 border border-slate-200 rounded-lg px-2 py-1.5" />
                            <input placeholder="Postal code" value={branchForm.postalCode} onChange={(e) => setBranchForm({ ...branchForm, postalCode: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5" />
                            <input placeholder="Phone" value={branchForm.phone} onChange={(e) => setBranchForm({ ...branchForm, phone: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5" />
                            <input placeholder="Email" value={branchForm.email} onChange={(e) => setBranchForm({ ...branchForm, email: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5" />
                            <input placeholder="Description" value={branchForm.description} onChange={(e) => setBranchForm({ ...branchForm, description: e.target.value })} className="sm:col-span-2 border border-slate-200 rounded-lg px-2 py-1.5" />
                            <label className="flex items-center gap-2 font-bold text-slate-600">
                              <input type="checkbox" checked={branchForm.isActive} onChange={(e) => setBranchForm({ ...branchForm, isActive: e.target.checked })} />
                              Active
                            </label>
                            <div className="flex gap-2 justify-end sm:col-span-2">
                              <button type="button" onClick={resetBranchForm} className="px-3 py-1.5 rounded-lg border border-slate-200 font-bold">Cancel</button>
                              <button type="submit" disabled={orgSaving} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-bold disabled:opacity-50">{orgSaving ? 'Saving…' : editingBranchId === 'new' ? 'Create branch' : 'Save branch'}</button>
                            </div>
                          </form>
                        );
                      })()}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <p className="text-[10px] text-slate-400 leading-relaxed">
            Delete permanently removes a campus or branch only when no students, users, classes, or other operational records reference it.
            Otherwise use Deactivate so historical data stays intact. Inactive campuses and branches are hidden from day-to-day operations.
          </p>
        </div>
      </div>

      {/* Owners Board Section */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-100 pb-4 gap-3">
          <div>
            <h3 className="text-base font-extrabold text-slate-900 flex items-center gap-1.5">
              <HeartHandshake className="w-5 h-5 text-indigo-600" />
              Owners board & equity partners
            </h3>
            <p className="text-xs text-slate-500 mt-1">Senior owners and each partner’s equity share</p>
          </div>
          {isOwner && !showAddForm && !editingPartnerId && (
            <button
              onClick={() => {
                clearForm();
                setShowAddForm(true);
              }}
              className="flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs px-3.5 py-2 rounded-xl cursor-pointer shadow-sm transition-all"
            >
              <Plus className="w-4 h-4" />
              Add partner
            </button>
          )}
        </div>

        {/* Dynamic Equity Distribution Progress Bar */}
        <div className="space-y-2">
          <div className="flex justify-between items-center text-xs font-bold text-slate-700">
            <span>Total equity distributed:</span>
            <span className={`${totalShares === 100 ? 'text-emerald-600' : totalShares > 100 ? 'text-rose-600' : 'text-amber-600'} font-mono`}>{totalShares}% of 100%</span>
          </div>
          <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden flex">
            {partners.map((p, idx) => {
              const bgColors = ['bg-indigo-600', 'bg-emerald-500', 'bg-amber-500', 'bg-sky-500', 'bg-rose-500'];
              const color = bgColors[idx % bgColors.length];
              return (
                <div
                  key={p.id}
                  className={`${color} h-full transition-all`}
                  style={{ width: `${p.sharePercent}%` }}
                  title={`${p.fullName}: ${p.sharePercent}%`}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500 font-medium">
            {partners.map((p, idx) => {
              const textColors = ['text-indigo-600', 'text-emerald-600', 'text-amber-600', 'text-sky-600', 'text-rose-600'];
              const color = textColors[idx % textColors.length];
              return (
                <span key={p.id} className="flex items-center gap-1">
                  <span className={`w-2.5 h-2.5 rounded-full ${color.replace('text', 'bg')}`} />
                  {p.fullName} ({p.sharePercent}%)
                </span>
              );
            })}
          </div>
        </div>

        {/* Edit Form or Add Form */}
        {(showAddForm || editingPartnerId) && (
          <div className="bg-slate-50/50 border border-slate-200 rounded-2xl p-5 text-xs max-w-2xl animate-in slide-in-from-top duration-200">
            <h4 className="font-extrabold text-slate-900 border-b border-slate-200 pb-2 mb-4">
              {showAddForm ? 'Register new partner' : `Edit partner: ${partnerName}`}
            </h4>
            <form onSubmit={showAddForm ? handleAddPartnerSubmit : handleEditPartnerSubmit} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="block text-slate-600 font-bold">Full name:</label>
                <input
                  type="text"
                  value={partnerName}
                  onChange={(e) => setPartnerName(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 focus:ring-1 focus:ring-indigo-500"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="block text-slate-600 font-bold">Phone:</label>
                <input
                  type="text"
                  value={partnerPhone}
                  onChange={(e) => setPartnerPhone(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 focus:ring-1 focus:ring-indigo-500 font-mono text-left"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="block text-slate-600 font-bold">Email:</label>
                <input
                  type="email"
                  value={partnerEmail}
                  onChange={(e) => setPartnerEmail(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 focus:ring-1 focus:ring-indigo-500 font-mono text-left"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="block text-slate-600 font-bold">Equity share (%):</label>
                <input
                  type="number"
                  value={partnerShare}
                  onChange={(e) => setPartnerShare(Number(e.target.value))}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 focus:ring-1 focus:ring-indigo-500 font-mono"
                  min="0"
                  max="100"
                  required
                />
              </div>

              <div className="sm:col-span-2 space-y-1">
                <label className="block text-slate-600 font-bold">Role / responsibilities:</label>
                <input
                  type="text"
                  value={partnerRole}
                  onChange={(e) => setPartnerRole(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 focus:ring-1 focus:ring-indigo-500"
                  placeholder="e.g. Chief finance officer, class supervisor"
                  required
                />
              </div>

              <div className="sm:col-span-2 flex gap-2 justify-end pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold"
                >
                  {showAddForm ? 'Save partner' : 'Save changes'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Partners Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {partners.map((p) => (
            <div key={p.id} className="bg-slate-50 border border-slate-150 rounded-2xl p-4 flex flex-col justify-between space-y-4 relative overflow-hidden">
              <div className="absolute top-0 left-0 bg-indigo-600 text-white font-mono font-black text-xs px-3.5 py-1.5 rounded-br-2xl">
                {p.sharePercent}%
              </div>
              <div className="space-y-1.5 pt-2">
                <div className="flex items-center gap-1.5">
                  <User className="w-4 h-4 text-indigo-500 shrink-0" />
                  <h4 className="font-extrabold text-slate-900 text-xs sm:text-sm">{p.fullName}</h4>
                </div>
                <p className="text-[11px] text-indigo-600 font-bold bg-indigo-50/50 px-2 py-0.5 rounded inline-block">{p.roleDescription}</p>
                
                <div className="space-y-1 pt-2 border-t border-slate-100 text-[10px] text-slate-500 font-semibold font-mono">
                  <p>Phone: <span className="text-slate-700">{p.phone}</span></p>
                  <p>Email: <span className="text-slate-700">{p.email}</span></p>
                </div>
              </div>

              {isOwner && (
                <div className="flex gap-2 justify-end pt-2 border-t border-slate-100">
                  <button
                    onClick={() => handleStartEdit(p)}
                    className="p-1.5 hover:bg-slate-200/60 rounded text-slate-600 cursor-pointer"
                    title="Edit details"
                  >
                    <Edit className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDeletePartner(p.id, p.fullName)}
                    className="p-1.5 hover:bg-rose-50 text-rose-500 rounded cursor-pointer"
                    title="Delete partner"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* User Account Management (owner only) */}
        {isOwner && (
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-slate-50 pb-2.5">
              <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-1.5">
                <KeyRound className="w-5 h-5 text-indigo-600" />
                User accounts
              </h3>
              {!showAddUserForm && (
                <button
                  onClick={() => setShowAddUserForm(true)}
                  className="flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs px-3.5 py-2 rounded-xl cursor-pointer shadow-sm transition-all"
                >
                  <UserPlus className="w-4 h-4" />
                  Create account
                </button>
              )}
            </div>

            {showAddUserForm && (
              <form onSubmit={handleCreateUser} className="bg-slate-50/50 border border-slate-200 rounded-2xl p-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs animate-in slide-in-from-top duration-200">
                <div className="space-y-1">
                  <label className="block text-slate-600 font-bold">Full name:</label>
                  <input type="text" value={newUserFullName} onChange={(e) => setNewUserFullName(e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2" required />
                </div>
                <div className="space-y-1">
                  <label className="block text-slate-600 font-bold">User role:</label>
                  <select value={newUserRole} onChange={(e) => setNewUserRole(e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 cursor-pointer">
                    {ALL_ROLES.filter((role) => role !== 'owner').map((role) => (
                      <option key={role} value={role}>{getRoleLabel(role)}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="block text-slate-600 font-bold">Username:</label>
                  <input type="text" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 font-mono text-left" placeholder="e.g. ahmad.karimi" required />
                </div>
                <div className="space-y-1">
                  <label className="block text-slate-600 font-bold">Temporary password:</label>
                  <input type="text" value={newTempPassword} onChange={(e) => setNewTempPassword(e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 font-mono text-left" placeholder="At least 12 characters" required />
                </div>
                <div className="sm:col-span-2 flex gap-2 justify-end pt-2 border-t border-slate-100">
                  <button type="button" onClick={() => setShowAddUserForm(false)} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg font-bold">Cancel</button>
                  <button type="submit" className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold">Create account</button>
                </div>
              </form>
            )}

            <div className="space-y-2">
              {userAccounts.map((u) => (
                <div key={u.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-slate-50 border border-slate-100 rounded-xl px-3.5 py-2.5 text-xs">
                  <div>
                    <p className="font-bold text-slate-800 flex items-center gap-1.5">
                      {u.fullName}
                      {!u.isActive && <span className="text-[9px] bg-rose-100 text-rose-600 px-1.5 py-0.5 rounded font-bold">Inactive</span>}
                      {u.mustChangePassword && <span className="text-[9px] bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded font-bold">Password change pending</span>}
                    </p>
                    <p className="text-[10px] text-slate-400 font-mono mt-0.5">{u.username} • {getRoleLabel(u.role)}</p>
                  </div>
                  {resettingUserId === u.id ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={resetTempPassword}
                        onChange={(e) => setResetTempPassword(e.target.value)}
                        placeholder="New temporary password"
                        className="bg-white border border-indigo-200 rounded-lg px-2 py-1.5 font-mono text-left w-32"
                        autoFocus
                      />
                      <button onClick={() => handleResetPassword(u.id)} className="text-emerald-600 hover:text-emerald-700 cursor-pointer" title="Save">
                        <CheckCircle2 className="w-4 h-4" />
                      </button>
                      <button onClick={() => setResettingUserId(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setResettingUserId(u.id); setResetTempPassword(''); }}
                      className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 cursor-pointer bg-indigo-50 px-3 py-1.5 rounded-lg self-start sm:self-auto"
                    >
                      Reset password
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {isOwner && (
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-5">
            <div className="flex items-center gap-1.5 border-b border-slate-50 pb-2.5">
              <ShieldCheck className="w-5 h-5 text-indigo-600" />
              <h3 className="text-sm font-extrabold text-slate-900">Positions &amp; access control</h3>
            </div>
            {positionError && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[11px] font-semibold text-rose-700">{positionError}</div>}
            <PositionsPanel
              positions={positions}
              permissionCatalog={permissionCatalog}
              load={loadPositions}
              createPosition={createPosition}
              updatePosition={updatePosition}
              updatePositionPermissions={updatePositionPermissions}
            />
            <div className="border-t border-slate-100 pt-5">
              <UserPositionsPanel
                users={(userAccounts as UserLite[])}
                positions={positions}
                branches={branchesList.map((b) => ({ id: b.id, name: b.name }))}
                campuses={campuses.map((c) => ({ id: c.id, name: c.name }))}
                loadUsers={async () => { loadUserAccounts(); }}
                listUserPositions={listUserPositions}
                assignUserPosition={assignUserPosition}
                removeUserPosition={removeUserPosition}
                viewEffectivePermissions={viewEffectivePermissions}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
