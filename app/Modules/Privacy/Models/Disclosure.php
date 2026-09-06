<?php

declare(strict_types=1);

namespace App\Modules\Privacy\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Recorded release of personal information: recipient, purpose, authority,
 * scope, time, and disclosed category. Append-only evidence.
 *
 * @property string $id
 * @property string $subject_person_id
 * @property string $recipient
 * @property string $purpose
 * @property string $authority
 * @property string $scope_type
 * @property string $scope_id
 * @property string $disclosed_category
 * @property string $disclosed_by
 */
final class Disclosure extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'subject_person_id', 'recipient', 'purpose', 'authority', 'scope_type', 'scope_id', 'disclosed_category', 'disclosed_by'];
}
