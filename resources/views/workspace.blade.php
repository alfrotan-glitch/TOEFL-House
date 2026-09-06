<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>{{ ($view ?? 'workspace') === 'crm' ? 'CRM — The TOEFL House' : (($view ?? 'workspace') === 'management' ? 'Management Workspace — The TOEFL House' : (($view ?? 'workspace') === 'students' ? 'Students & Admissions — The TOEFL House' : (($view ?? 'workspace') === 'academic' ? 'Academic Classes — The TOEFL House' : (($view ?? 'workspace') === 'teachers' ? 'Teacher & Faculty — The TOEFL House' : 'Employee Workspace — The TOEFL House'))))) }}</title>
    @vite('resources/js/app.tsx')
</head>
<body>
    <div id="react-console" data-view="{{ $view ?? 'workspace' }}" data-students-view="{{ $students_view ?? 'directory' }}" data-student-id="{{ $student_id ?? '' }}" data-api-base="/api/v1" data-csrf-token="{{ csrf_token() }}"></div>
</body>
</html>
