/**
 * @license SPDX-License-Identifier: Apache-2.0
 *
 * Class Detail Drawer (LMS Core)
 * Manages Roster, Gradebook, and Class Lifecycle (Activation & Completion).
 */
import { control, text } from '../../design-system/styles';
import React, { useState, useEffect, useCallback } from 'react';
import {X, Settings, Plus, Save, Lock, Play, CheckCircle, Loader2} from 'lucide-react';
import {Class} from '../../types';

interface ClassDetailDrawerProps {
  classData: Class;
  onClose: () => void;
  activateClass?: (classId: string) => Promise<void>;
  getClassGradebook: (classId: string) => Promise<any>;
  createClassAssessment?: (classId: string, payload: { title: string; type: string; weight: number; maxScore: number; date?: string }) => Promise<void>;
  saveClassGrades?: (classId: string, grades: Array<{ assessmentId: string; studentId: string; score: number; status: string }>) => Promise<void>;
  completeClassSemester?: (classId: string) => Promise<void>;
  triggerToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

interface RosterStudent {
  id: string;
  full_name: string;
  student_code: string;
  semester_id: string;
}

interface Assessment {
  id: string;
  title: string;
  type: string;
  weight: number;
  max_score: number;
}

export function ClassDetailDrawer({
  classData, onClose, activateClass, getClassGradebook, createClassAssessment, saveClassGrades, completeClassSemester, triggerToast
}: ClassDetailDrawerProps) {
  const [activeTab, setActiveTab] = useState<'roster' | 'gradebook' | 'settings'>('gradebook');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [processingAction, setProcessingAction] = useState(false);

  const [students, setStudents] = useState<RosterStudent[]>([]);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [grades, setGrades] = useState<Record<string, number | ''>>({}); // Key: `${studentId}_${assessmentId}`

  // New Assessment Form State
  const [showAssessmentForm, setShowAssessmentForm] = useState(false);
  const [newAssessment, setNewAssessment] = useState({ title: '', type: 'midterm', weight: 20, maxScore: 100 });

  const fetchGradebook = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getClassGradebook(classData.id);
      setStudents(data.students || []);
      setAssessments(data.assessments || []);
      
      const gradeMap: Record<string, number | ''> = {};
      (data.grades || []).forEach((g: any) => {
        gradeMap[`${g.studentId}_${g.assessmentId}`] = g.score ?? '';
      });
      setGrades(gradeMap);
    } catch {
      triggerToast('Failed to load class data.', 'error');
    } finally {
      setLoading(false);
    }
  }, [classData.id, getClassGradebook, triggerToast]);

  useEffect(() => {
    void (async () => { await fetchGradebook(); })();
  }, [fetchGradebook]);

  const handleGradeChange = (studentId: string, assessmentId: string, value: string) => {
    setGrades(prev => ({ ...prev, [`${studentId}_${assessmentId}`]: value === '' ? '' : Number(value) }));
  };

  const handleSaveGrades = async () => {
    if (!saveClassGrades) return;
    setSaving(true);
    
    const gradesArray = Object.entries(grades).map(([key, score]) => {
      const [studentId, assessmentId] = key.split('_');
      return { studentId, assessmentId, score: score === '' ? 0 : Number(score), status: 'graded' };
    });

    try {
      await saveClassGrades(classData.id, gradesArray);
      triggerToast('Grades saved successfully.', 'success');
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Failed to save grades.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateAssessment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createClassAssessment) return;
    if (!newAssessment.title) return triggerToast('Assessment title is required.', 'error');
    
    setProcessingAction(true);
    try {
      await createClassAssessment(classData.id, newAssessment);
      triggerToast('Assessment created successfully.', 'success');
      setShowAssessmentForm(false);
      setNewAssessment({ title: '', type: 'midterm', weight: 20, maxScore: 100 });
      await fetchGradebook(); // Refresh data
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Failed to create assessment.', 'error');
    } finally {
      setProcessingAction(false);
    }
  };

  const handleActivateClass = async () => {
    if (!activateClass) return;
    setProcessingAction(true);
    try {
      await activateClass(classData.id);
      triggerToast('Class activated successfully. Payroll engine is now tracking this class.', 'success');
      onClose();
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Failed to activate class.', 'error');
    } finally {
      setProcessingAction(false);
    }
  };

  const handleCompleteSemester = async () => {
    if (!completeClassSemester) return;
    if (!window.confirm('WARNING: This will finalize all grades, promote passing students, and LOCK the class. Are you sure?')) return;
    
    setProcessingAction(true);
    try {
      await completeClassSemester(classData.id);
      triggerToast('Semester completed successfully. Students have been processed.', 'success');
      onClose();
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Failed to complete semester.', 'error');
    } finally {
      setProcessingAction(false);
    }
  };

  // Calculate Final Percentage for a student
  const calculateFinalScore = (studentId: string) => {
    let totalWeightAchieved = 0;
    let totalWeight = 0;
    assessments.forEach(a => {
      totalWeight += a.weight;
      const score = grades[`${studentId}_${a.id}`];
      if (score !== undefined && score !== '') {
        totalWeightAchieved += (Number(score) / a.max_score) * a.weight;
      }
    });
    return totalWeight > 0 ? (totalWeightAchieved / totalWeight) * 100 : 0;
  };

  const statusColors: Record<string, string> = {
    scheduled: 'bg-amber-50 text-amber-700 border-amber-200',
    active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    completed: 'bg-slate-100 text-slate-500 border-slate-200',
    cancelled: 'bg-rose-50 text-rose-700 border-rose-200',
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50 backdrop-blur-sm">
      <div className="bg-slate-50 w-full max-w-5xl h-full shadow-2xl flex flex-col animate-in slide-in-from-right duration-300">
        
        {/* Header */}
        <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shrink-0">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-extrabold text-slate-900">{classData.name}</h2>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border capitalize ${statusColors[classData.status] || statusColors.active}`}>
                {classData.status}
              </span>
            </div>
            <p className={text.hint}>
              Level: {classData.level} · Fee: {classData.fee} AFN · Schedule: {classData.scheduleTime || 'N/A'}
            </p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 rounded-lg cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </header>

        {/* Tabs */}
        <div className="bg-white border-b border-slate-200 px-6 shrink-0">
          <div className="flex gap-6">
            <button onClick={() => setActiveTab('gradebook')} className={`py-3 text-sm font-semibold border-b-2 transition-colors ${activeTab === 'gradebook' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
              Gradebook
            </button>
            <button onClick={() => setActiveTab('roster')} className={`py-3 text-sm font-semibold border-b-2 transition-colors ${activeTab === 'roster' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
              Roster ({students.length})
            </button>
            <button onClick={() => setActiveTab('settings')} className={`py-3 text-sm font-semibold border-b-2 transition-colors ${activeTab === 'settings' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
              Class Settings
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
              <span className="text-xs font-semibold uppercase tracking-wide">Loading LMS Data...</span>
            </div>
          ) : (
            <>
              {/* GRADEBOOK TAB */}
              {activeTab === 'gradebook' && (
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <h3 className="text-lg font-bold text-slate-800">Gradebook & Assessments</h3>
                    {classData.status !== 'completed' && createClassAssessment && (
                      <button onClick={() => setShowAssessmentForm(!showAssessmentForm)} className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-3 py-2 rounded-lg cursor-pointer">
                        <Plus className="w-4 h-4" /> Add Assessment
                      </button>
                    )}
                  </div>

                  {showAssessmentForm && (
                    <form onSubmit={handleCreateAssessment} className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end text-xs">
                      <div className="md:col-span-2">
                        <label className={text.label}>Title (e.g., Midterm Exam)</label>
                        <input type="text" value={newAssessment.title} onChange={e => setNewAssessment({...newAssessment, title: e.target.value})} className={control.input} required />
                      </div>
                      <div>
                        <label className={text.label}>Type</label>
                        <select value={newAssessment.type} onChange={e => setNewAssessment({...newAssessment, type: e.target.value})} className={control.input}>
                          <option value="midterm">Midterm</option>
                          <option value="final">Final</option>
                          <option value="assignment">Assignment</option>
                          <option value="participation">Participation</option>
                        </select>
                      </div>
                      <div>
                        <label className={text.label}>Weight (%)</label>
                        <input type="number" min={0} max={100} value={newAssessment.weight} onChange={e => setNewAssessment({...newAssessment, weight: Number(e.target.value)})} className={control.input} required />
                      </div>
                      <div>
                        <label className={text.label}>Max Score</label>
                        <input type="number" min={1} value={newAssessment.maxScore} onChange={e => setNewAssessment({...newAssessment, maxScore: Number(e.target.value)})} className={control.input} required />
                      </div>
                      <div className="md:col-span-4 flex justify-end gap-2 pt-2 border-t border-slate-100 mt-2">
                        <button type="button" onClick={() => setShowAssessmentForm(false)} className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg font-semibold">Cancel</button>
                        <button type="submit" disabled={processingAction} className="px-4 py-2 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1.5">
                          {processingAction ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save Assessment
                        </button>
                      </div>
                    </form>
                  )}

                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs text-start border-collapse">
                        <thead className="bg-slate-50 border-b border-slate-200">
                          <tr>
                            <th className="py-3 px-4 font-bold text-slate-700 sticky start-0 bg-slate-50 z-10">Student</th>
                            {assessments.map(a => (
                              <th key={a.id} className="py-3 px-4 font-bold text-slate-700 text-center min-w-[120px]">
                                {a.title}<br/>
                                <span className="text-[10px] font-normal text-slate-400">Weight: {a.weight}% | Max: {a.max_score}</span>
                              </th>
                            ))}
                            <th className="py-3 px-4 font-bold text-slate-700 text-center bg-indigo-50/50">Final %</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {students.length === 0 ? (
                            <tr>
                              <td colSpan={assessments.length + 2} className="text-center py-8 text-slate-400 italic">
                                No active students enrolled in this class.
                              </td>
                            </tr>
                          ) : (
                            students.map(student => (
                              <tr key={student.id} className="hover:bg-slate-50/50">
                                <td className="py-3 px-4 font-medium text-slate-800 sticky start-0 bg-white z-10">
                                  {student.full_name}
                                  <span className="block text-[10px] text-slate-400 font-mono">{student.student_code}</span>
                                </td>
                                {assessments.map(a => (
                                  <td key={a.id} className="py-2 px-4 text-center">
                                    <input
                                      type="number"
                                      value={grades[`${student.id}_${a.id}`] ?? ''}
                                      onChange={(e) => handleGradeChange(student.id, a.id, e.target.value)}
                                      placeholder="-"
                                      disabled={classData.status === 'completed'}
                                      className="w-20 text-center bg-slate-50 border border-slate-200 rounded-md px-2 py-1 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none disabled:bg-slate-100 disabled:cursor-not-allowed"
                                    />
                                  </td>
                                ))}
                                <td className="py-3 px-4 text-center font-bold font-mono text-indigo-700 bg-indigo-50/30">
                                  {calculateFinalScore(student.id).toFixed(1)}%
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {classData.status !== 'completed' && students.length > 0 && saveClassGrades && (
                    <div className="flex justify-end pt-4">
                      <button onClick={handleSaveGrades} disabled={saving} className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-6 py-2.5 rounded-lg cursor-pointer disabled:opacity-50">
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Save All Grades
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ROSTER TAB */}
              {activeTab === 'roster' && (
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <table className="w-full text-xs text-start">
                    <thead className="bg-slate-50 border-b border-slate-200">
                      <tr>
                        <th className="py-3 px-4 font-bold text-slate-700">Student Name</th>
                        <th className="py-3 px-4 font-bold text-slate-700">Student Code</th>
                        <th className="py-3 px-4 font-bold text-slate-700">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {students.length === 0 ? (
                        <tr><td colSpan={3} className="text-center py-8 text-slate-400 italic">No active students enrolled.</td></tr>
                      ) : (
                        students.map(s => (
                          <tr key={s.id} className="hover:bg-slate-50">
                            <td className="py-3 px-4 font-medium text-slate-800">{s.full_name}</td>
                            <td className="py-3 px-4 font-mono text-slate-500">{s.student_code}</td>
                            <td className="py-3 px-4"><span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">Active</span></td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* SETTINGS TAB */}
              {activeTab === 'settings' && (
                <div className="space-y-6 max-w-xl">
                  <div className="bg-white border border-slate-200 rounded-xl p-5">
                    <h3 className="text-sm font-bold text-slate-900 mb-3 flex items-center gap-2">
                      <Settings className="w-4 h-4 text-slate-500" /> Class Lifecycle Management
                    </h3>
                    
                    <div className="space-y-4 text-xs">
                      {/* Activation Section */}
                      <div className={`p-4 rounded-lg border ${classData.lifecycleStage === 'scheduled' ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}`}>
                        <div className="flex justify-between items-center">
                          <div>
                            <p className="font-bold text-slate-800">1. Class Activation</p>
                            <p className="text-slate-500 mt-1">
                              {classData.lifecycleStage === 'scheduled' 
                                ? 'Class is scheduled. Payroll and attendance are disabled until activation.' 
                                : `Class was activated on ${classData.activationDate || 'N/A'}.`}
                            </p>
                          </div>
                          {classData.lifecycleStage === 'scheduled' && activateClass && (
                            <button onClick={handleActivateClass} disabled={processingAction} className="flex items-center gap-1.5 bg-amber-600 hover:bg-amber-700 text-white font-bold px-4 py-2 rounded-lg disabled:opacity-50">
                              {processingAction ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                              Activate Now
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Completion Section */}
                      <div className={`p-4 rounded-lg border ${classData.status === 'active' ? 'bg-indigo-50 border-indigo-200' : 'bg-slate-50 border-slate-200'}`}>
                        <div className="flex justify-between items-center">
                          <div>
                            <p className="font-bold text-slate-800">2. Semester Completion</p>
                            <p className="text-slate-500 mt-1">
                              {classData.status === 'active' 
                                ? 'Finalize grades, promote passing students, and lock the class.' 
                                : classData.status === 'completed' ? 'Semester is completed and locked.' : 'Activate the class first.'}
                            </p>
                          </div>
                          {classData.status === 'active' && completeClassSemester && (
                            <button onClick={handleCompleteSemester} disabled={processingAction} className="flex items-center gap-1.5 bg-rose-600 hover:bg-rose-700 text-white font-bold px-4 py-2 rounded-lg disabled:opacity-50">
                              {processingAction ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
                              Complete Semester
                            </button>
                          )}
                        </div>
                      </div>
                      
                      {classData.status === 'completed' && (
                         <div className="p-4 rounded-lg border bg-emerald-50 border-emerald-200 flex items-center gap-2 text-emerald-700">
                           <CheckCircle className="w-5 h-5" />
                           <p className="font-bold text-sm">This class is fully completed. Student records have been updated.</p>
                         </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}