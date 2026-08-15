import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import { buildCourseOptions, buildEducationalSections, type CourseOption } from '../utils/academicOptions';
import type { Class } from '../types';

// It's better to move these to your central types file, but kept here for encapsulation.
interface ProgramRow {
  id: string;
  name: string;
  isActive?: boolean;
}
interface LevelRow {
  id: string;
  programId: string;
  name: string;
  code?: string | null;
  isActive?: boolean;
}

export function useAcademicOptions(classes: Class[] = [], branchId?: string) {
  const [programs, setPrograms] = useState<ProgramRow[]>([]);
  const [levels, setLevels] = useState<LevelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAcademicData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';
      const [progs, lvls] = await Promise.all([
        api.get<ProgramRow[]>(`/academic/programs${q}`),
        api.get<LevelRow[]>(`/academic/levels${q}`),
      ]);
      const activeProgs = (Array.isArray(progs) ? progs : []).filter(p => p.isActive !== false);
      const activeLvls = (Array.isArray(lvls) ? lvls : []).filter(l => l.isActive !== false);
      
      setPrograms(activeProgs);
      setLevels(activeLvls);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        setError(e.message);
      } else if (e instanceof Error) {
        setError(e.message);
      } else {
        setError('Failed to load academic catalog');
      }
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      await fetchAcademicData();
      // Prevent state updates if component unmounted during fetch
      if (cancelled) return; 
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchAcademicData]);

  const courseOptions: CourseOption[] = useMemo(
    () => buildCourseOptions({ programs, levels, classes }),
    [programs, levels, classes]
  );

  const educationalSections = useMemo(() => buildEducationalSections(programs), [programs]);

  const courseValues = useMemo(() => courseOptions.map((o) => o.value), [courseOptions]);

  return {
    programs,
    levels,
    courseOptions,
    courseValues,
    educationalSections,
    loading,
    error,
    isEmpty: !loading && courseOptions.length === 0,
    refetch: fetchAcademicData,
  };
}