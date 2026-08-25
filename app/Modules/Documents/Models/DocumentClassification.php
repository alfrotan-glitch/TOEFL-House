<?php

declare(strict_types=1);

namespace App\Modules\Documents\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Sensitivity label for a document category with an owning module and an
 * access class from the data classification model.
 *
 * @property string $id
 * @property string $category
 * @property string $owner_module
 * @property string $access_class
 */
final class DocumentClassification extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'category', 'owner_module', 'access_class'];
}
