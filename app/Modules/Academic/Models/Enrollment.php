<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Student membership in a class through its lifecycle; transfer closes the
 * old row and opens a new one — never a duplicate active seat.
 *
 * @property string $id
 * @property string $student_id
 * @property string $class_id
 * @property string $lifecycle_state
 * @property string|null $originating_branch_id
 * @property string|null $current_home_branch_id
 * @property string|null $offering_id
 */
final class Enrollment extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'student_id', 'class_id', 'lifecycle_state', 'originating_branch_id', 'current_home_branch_id', 'offering_id'];
}
