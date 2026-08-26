<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Issued certificate/diploma output: immutable issuance record with a
 * unique serial, produced only by an approved graduation decision.
 *
 * @property string $id
 * @property string $graduation_decision_id
 * @property string $student_id
 * @property string $serial
 */
final class Certificate extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'graduation_decision_id', 'student_id', 'serial'];
}
