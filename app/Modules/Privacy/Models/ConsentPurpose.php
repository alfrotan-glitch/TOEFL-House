<?php

declare(strict_types=1);

namespace App\Modules\Privacy\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Defined purpose of personal-data use; communication and marketing
 * purposes are defined separately and never conflated.
 *
 * @property string $id
 * @property string $name
 * @property string $channel
 * @property string $category
 */
final class ConsentPurpose extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'name', 'channel', 'category'];
}
