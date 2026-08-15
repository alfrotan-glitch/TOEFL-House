export interface CourseOption {
  value: string;
  label: string;
  source: 'program' | 'level' | 'class';
  programId?: string;
  levelId?: string;
  classId?: string;
}

/** Build course/interest options strictly from academic configuration + live classes. */
export function buildCourseOptions(params: {
  programs?: Array<{ id: string; name: string; isActive?: boolean }>;
  levels?: Array<{ id: string; programId: string; name: string; code?: string | null; isActive?: boolean }>;
  classes?: Array<{ id: string; name: string; level?: string; status?: string }>;
}): CourseOption[] {
  const options: CourseOption[] = [];
  const seen = new Set<string>();

  const add = (opt: CourseOption) => {
    const key = opt.value.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    options.push(opt);
  };

  for (const p of params.programs || []) {
    if (p.isActive === false) continue;
    add({ value: p.name, label: p.name, source: 'program', programId: p.id });
  }

  for (const l of params.levels || []) {
    if (l.isActive === false) continue;
    const label = l.code ? `${l.name} (${l.code})` : l.name;
    add({ value: l.name, label, source: 'level', levelId: l.id, programId: l.programId });
  }

  for (const c of params.classes || []) {
    if (c.status && c.status !== 'active') continue;
    add({ value: c.name, label: c.name, source: 'class', classId: c.id });
  }

  return options.sort((a, b) => a.label.localeCompare(b.label));
}

/** Section picker for student forms: programs as primary sections. */
export function buildEducationalSections(
  programs: Array<{ id: string; name: string; isActive?: boolean }>
): Array<{ id: string; name: string }> {
  return (programs || [])
    .filter((p) => p.isActive !== false)
    .map((p) => ({ id: p.id, name: p.name }));
}
