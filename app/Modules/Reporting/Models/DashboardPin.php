<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * An explicit metric/period/scope pin on a dashboard; immutable history.
 *
 * @property string $id
 * @property string $dashboard_id
 * @property string $metric_id
 * @property string $period_key
 */
final class DashboardPin extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'dashboard_id', 'metric_id', 'period_key', 'scope_type', 'scope_id', 'pinned_by'];
}
