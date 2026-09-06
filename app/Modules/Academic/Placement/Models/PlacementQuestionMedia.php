<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Checksummed media attached to a question. The checksum is part of the
 * anti-tamper evidence set.
 *
 * @property string $id
 * @property string $question_id
 * @property string $uri
 * @property string $media_type
 * @property string $sha256
 * @property string $mime_type
 * @property string $lifecycle_state
 */
final class PlacementQuestionMedia extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'question_id', 'uri', 'media_type', 'sha256', 'mime_type', 'lifecycle_state'];

    /** @return BelongsTo<PlacementQuestion, $this> */
    public function question(): BelongsTo
    {
        return $this->belongsTo(PlacementQuestion::class, 'question_id');
    }
}
