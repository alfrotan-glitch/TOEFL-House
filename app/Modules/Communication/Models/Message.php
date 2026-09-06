<?php

declare(strict_types=1);

namespace App\Modules\Communication\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Outbound message queued post-commit under an active consent purpose; sent and failed are retained history. @property string $id @property string $subject_person_id @property string $purpose_id @property string $channel @property string $lifecycle_state
 */
final class Message extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'subject_person_id', 'purpose_id', 'channel', 'content_ref', 'lifecycle_state', 'delivery_ref', 'created_by'];
}
