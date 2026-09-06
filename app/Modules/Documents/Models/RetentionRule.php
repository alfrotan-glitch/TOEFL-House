<?php

declare(strict_types=1);

namespace App\Modules\Documents\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Retention control for a document category: period with legal and
 * operational basis; deletion is replaced by archive.
 *
 * @property string $id
 * @property string $category
 * @property int $retention_days
 * @property string $legal_basis
 * @property string|null $operational_basis
 */
final class RetentionRule extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'category', 'retention_days', 'legal_basis', 'operational_basis'];
}
