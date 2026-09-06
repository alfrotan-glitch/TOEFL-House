<?php

declare(strict_types=1);

namespace App\Modules\Students\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Student-owned per-channel communication preference. Communication module
 * enforces consent and purpose; Student records whether a channel is enabled
 * for the learner.
 *
 * @property string $id
 * @property string $student_id
 * @property string $channel
 * @property bool $enabled
 * @property string $updated_by
 */
final class StudentCommunicationPreference extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'student_id', 'channel', 'enabled', 'updated_by'];
}
