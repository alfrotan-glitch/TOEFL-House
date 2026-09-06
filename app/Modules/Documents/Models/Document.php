<?php

declare(strict_types=1);

namespace App\Modules\Documents\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Evidence document of one subject under a classification, moving through
 * the document lifecycle with version and verification history.
 *
 * @property string $id
 * @property string $subject_person_id
 * @property string $classification_id
 * @property string $title
 * @property string $lifecycle_state
 */
final class Document extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'subject_person_id', 'classification_id', 'title', 'lifecycle_state'];

    /** @return BelongsTo<DocumentClassification, $this> */
    public function classification(): BelongsTo
    {
        return $this->belongsTo(DocumentClassification::class);
    }

    /** @return HasMany<DocumentVersion, $this> */
    public function versions(): HasMany
    {
        return $this->hasMany(DocumentVersion::class);
    }
}
