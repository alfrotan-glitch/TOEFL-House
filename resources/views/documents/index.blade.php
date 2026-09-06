@extends('layouts.app')

@section('title', 'Documents')

@section('content')
<div class="card">
    <h1>Documents</h1>
    <p class="sub">The evidence-document registry: classifications and retention rules, registered documents against known subjects, append-only immutable versions, verification by a distinct employee, and retention decisions under the category's rule. History is never rewritten.</p>
</div>

<div class="row">
    <div class="card" style="flex:1 1 320px">
        <h2>Classifications</h2>
        <p class="sub">A category owned by a module with an access class; documents register against it.</p>
        <form method="POST" action="{{ route('documents.classification.define') }}">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <div class="row">
                <div>
                    <label>Category</label>
                    <input name="category" type="text" required>
                </div>
                <div>
                    <label>Owner module</label>
                    <input name="owner_module" type="text" required>
                </div>
                <div>
                    <label>Access class</label>
                    <input name="access_class" type="text" required>
                </div>
            </div>
            <div class="actions"><button type="submit" class="btn">Define classification</button></div>
        </form>
        @if ($classifications->isEmpty())
            <p class="empty">No classifications defined.</p>
        @else
            <table class="grid" style="margin-top:8px">
                <tr><th>Category</th><th>Owner</th><th>Access</th></tr>
                @foreach ($classifications as $classification)
                    <tr>
                        <td>{{ $classification->category }}</td>
                        <td>{{ $classification->owner_module }}</td>
                        <td><span class="pill">{{ $classification->access_class }}</span></td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>

    <div class="card" style="flex:1 1 320px">
        <h2>Retention rules</h2>
        <p class="sub">One positive period per category with its legal basis; a retention decision applies it.</p>
        <form method="POST" action="{{ route('documents.retention.rule') }}">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <div class="row">
                <div>
                    <label>Category</label>
                    <input name="category" type="text" required>
                </div>
                <div>
                    <label>Retention days</label>
                    <input name="retention_days" type="number" min="1" required>
                </div>
                <div>
                    <label>Legal basis</label>
                    <input name="legal_basis" type="text" required>
                </div>
                <div>
                    <label>Operational basis (optional)</label>
                    <input name="operational_basis" type="text">
                </div>
            </div>
            <div class="actions"><button type="submit" class="btn">Define retention rule</button></div>
        </form>
        @if ($retentionRules->isEmpty())
            <p class="empty">No retention rules defined.</p>
        @else
            <table class="grid" style="margin-top:8px">
                <tr><th>Category</th><th>Days</th><th>Legal basis</th></tr>
                @foreach ($retentionRules as $rule)
                    <tr>
                        <td>{{ $rule->category }}</td>
                        <td>{{ $rule->retention_days }}</td>
                        <td class="muted">{{ \Illuminate\Support\Str::limit($rule->legal_basis, 30) }}</td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>
</div>

<div class="card">
    <h2>Register a document</h2>
    <p class="sub">A document requires a known subject and a defined classification; the first version is recorded at registration.</p>
    <form method="POST" action="{{ route('documents.register') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Subject</label>
                <select name="subject_person_id" required>
                    <option value="">Select a subject…</option>
                    @foreach ($people as $person)
                        <option value="{{ $person->id }}">{{ $person->legal_name }}</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Classification</label>
                <select name="classification_id" required>
                    <option value="">Select a classification…</option>
                    @foreach ($classifications as $classification)
                        <option value="{{ $classification->id }}">{{ $classification->category }} ({{ $classification->access_class }})</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Title</label>
                <input name="title" type="text" required>
            </div>
            <div>
                <label>Content hash</label>
                <input name="content_hash" type="text" required>
            </div>
            <div>
                <label>Storage reference</label>
                <input name="storage_ref" type="text" required>
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Register document</button></div>
    </form>
</div>

<div class="card">
    <h2>Documents (newest first)</h2>
    <p class="sub">draft → submitted → verified / rejected (a rejection resubmits as a new version) → verified → active → expired / archived. Versions are append-only and immutable.</p>
    @if ($documents->isEmpty())
        <p class="empty">No documents registered.</p>
    @else
        <table class="grid">
            <tr><th>Title</th><th>Subject</th><th>Classification</th><th>State</th><th>Actions</th></tr>
            @foreach ($documents as $document)
                <tr>
                    <td>{{ $document->title }}</td>
                    <td>{{ \Illuminate\Support\Str::limit($document->subject_person_id, 16) }}</td>
                    <td>{{ \Illuminate\Support\Str::limit($document->classification_id, 16) }}</td>
                    <td><span class="pill {{ $document->lifecycle_state === 'active' ? 'ok' : '' }}">{{ $document->lifecycle_state }}</span></td>
                    <td>
                        @if ($document->lifecycle_state === 'draft' || $document->lifecycle_state === 'rejected')
                            <form method="POST" action="{{ route('documents.submit', $document->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input name="content_hash" type="text" placeholder="Content hash" required>
                                <input name="storage_ref" type="text" placeholder="Storage reference" required>
                                <button type="submit" class="btn small">Submit version</button>
                            </form>
                        @endif
                        @if ($document->lifecycle_state === 'submitted')
                            <form method="POST" action="{{ route('documents.verify', $document->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <select name="result" required>
                                    <option value="pass">Pass</option>
                                    <option value="fail">Fail</option>
                                </select>
                                <input name="reason" type="text" placeholder="Reason" required>
                                <button type="submit" class="btn small">Verify</button>
                            </form>
                        @endif
                        @if ($document->lifecycle_state === 'verified')
                            <form method="POST" action="{{ route('documents.activate', $document->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Activate</button>
                            </form>
                        @endif
                        @if ($document->lifecycle_state === 'active')
                            <form method="POST" action="{{ route('documents.expire', $document->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Expire</button>
                            </form>
                            <form method="POST" action="{{ route('documents.archive', $document->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small secondary">Archive</button>
                            </form>
                        @endif
                        @if ($document->lifecycle_state === 'expired')
                            <form method="POST" action="{{ route('documents.archive', $document->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small secondary">Archive</button>
                            </form>
                        @endif
                        <form method="POST" action="{{ route('documents.retention.decide', $document->id) }}" style="display:inline">
                            @csrf
                            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                            <button type="submit" class="btn small secondary" title="Applies the retention rule of the document's classification">Retention</button>
                        </form>
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="row">
    <div class="card" style="flex:1 1 320px">
        <h2>Versions (newest first)</h2>
        @if ($versions->isEmpty())
            <p class="empty">No versions recorded.</p>
        @else
            <table class="grid">
                <tr><th>Document</th><th>Version</th><th>Content hash</th><th>Uploaded by</th></tr>
                @foreach ($versions as $version)
                    <tr>
                        <td>{{ \Illuminate\Support\Str::limit($version->document_id, 16) }}</td>
                        <td>{{ $version->version_no }}</td>
                        <td><code>{{ \Illuminate\Support\Str::limit($version->content_hash, 20) }}</code></td>
                        <td>{{ \Illuminate\Support\Str::limit($version->uploaded_by, 16) }}</td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>

    <div class="card" style="flex:1 1 320px">
        <h2>Retention decisions (newest first)</h2>
        @if ($retentionDecisions->isEmpty())
            <p class="empty">No retention decisions recorded.</p>
        @else
            <table class="grid">
                <tr><th>Document</th><th>Action</th><th>Basis</th><th>Decided by</th></tr>
                @foreach ($retentionDecisions as $decision)
                    <tr>
                        <td>{{ \Illuminate\Support\Str::limit($decision->document_id, 16) }}</td>
                        <td><span class="pill">{{ $decision->action }}</span></td>
                        <td class="muted">{{ \Illuminate\Support\Str::limit($decision->basis, 30) }}</td>
                        <td>{{ \Illuminate\Support\Str::limit($decision->decided_by, 16) }}</td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>
</div>
@endsection
