<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Issued official transcript: an immutable, hashed freeze of a student's
 * academic record for one program version, produced by IssueTranscript and
 * governed as a managed document. Prints render the stored payload — the
 * row is never updated (database trigger) so issued history cannot drift.
 *
 * @property string $id
 * @property string $student_id
 * @property string $program_version_id
 * @property array<string, mixed> $payload
 * @property string $content_hash
 * @property string|null $document_id
 * @property string $issued_by
 * @property Carbon $issued_at
 */
final class Transcript extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'student_id', 'program_version_id', 'payload', 'content_hash',
        'document_id', 'issued_by', 'issued_at',
    ];

    protected $casts = [
        'payload' => 'array',
        'issued_at' => 'datetime',
    ];
}
