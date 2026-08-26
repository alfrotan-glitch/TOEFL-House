<?php

declare(strict_types=1);

namespace App\Modules\Resources\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Immutable catalog copy; circulation state derived from issuances. @property string $id @property string $code @property string $title
 */
final class BookCopy extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'code', 'title', 'acquired_on'];
}
