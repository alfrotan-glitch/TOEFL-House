<?php

declare(strict_types=1);

namespace App\Modules\Documents\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Immutable content version: hash and storage reference; corrections
 * append a new version, they never rewrite one.
 *
 * @property string $id
 * @property string $document_id
 * @property int $version_no
 * @property string $content_hash
 * @property string $storage_ref
 * @property string $uploaded_by
 */
final class DocumentVersion extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'document_id', 'version_no', 'content_hash', 'storage_ref', 'uploaded_by'];
}
