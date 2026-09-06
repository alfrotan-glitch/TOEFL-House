<?php

declare(strict_types=1);

namespace App\Modules\Documents\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Recorded validation of one document version: verifier, result, reason,
 * and time. Append-only evidence; a failed verification never passes
 * silently.
 *
 * @property string $id
 * @property string $document_id
 * @property int $version_no
 * @property string $verifier_person_id
 * @property string $result
 * @property string $reason
 */
final class DocumentVerification extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'document_id', 'version_no', 'verifier_person_id', 'result', 'reason'];
}
