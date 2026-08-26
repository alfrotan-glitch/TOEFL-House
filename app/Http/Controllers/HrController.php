<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Hr\Commands\MaintainContractVersion;
use App\Modules\Hr\Commands\MaintainEmployment;
use App\Modules\Hr\Models\Contract;
use App\Modules\Hr\Models\ContractVersion;
use App\Modules\Hr\Models\Employment;
use App\Modules\Hr\Models\Leave;
use App\Modules\Hr\Models\Scale;
use App\Modules\Identity\Models\Person;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Teachers &amp; HR console: the teacher lifecycle (employment, contract
 * versions with FM→GM approval, scales, leave). Employment and contract
 * version operations delegate to the HR module commands, which own the
 * separation of duties, immutability, and audit.
 */
final class HrController extends Controller
{
    public function index(): View
    {
        return view('hr.index', [
            'employments' => Employment::query()->orderBy('id')->limit(200)->get(),
            'scales' => Scale::query()->orderBy('rank_order')->get(),
            'leaves' => Leave::query()->orderBy('date_from')->limit(200)->get(),
            'people' => Person::query()->where('verification_state', 'verified')->orderBy('legal_name')->limit(300)->get(),
        ]);
    }

    public function contracts(): View
    {
        $contracts = Contract::query()->orderBy('id')->get()->keyBy('id');

        return view('hr.contracts', [
            'versions' => ContractVersion::query()->orderByDesc('effective_from')->limit(200)->get(),
            'contracts' => $contracts,
            'employments' => Employment::query()->orderBy('id')->get(),
            'scales' => Scale::query()->where('lifecycle_state', 'active')->orderBy('rank_order')->get(),
        ]);
    }

    public function employ(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'person_id' => ['required', 'string'],
        ]);

        app(MaintainEmployment::class)->employ(
            $this->actor(),
            $input['person_id'],
            $this->idempotencyKey('hr.employ'),
        );

        return redirect()->route('hr.index')->with('success', 'Employment created as a candidate. Prepare and approve a contract version, then hire.');
    }

    public function prepareVersion(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'employment_id' => ['required', 'string'],
            'terms_ref' => ['required', 'string', 'max:255'],
            'scale_id' => ['nullable', 'string'],
            'effective_from' => ['required', 'date'],
            'effective_to' => ['nullable', 'date', 'after_or_equal:effective_from'],
        ]);

        app(MaintainContractVersion::class)->prepare(
            $this->actor(),
            Employment::query()->findOrFail($input['employment_id']),
            $input['terms_ref'],
            $input['scale_id'] !== null && $input['scale_id'] !== '' ? $input['scale_id'] : null,
            $input['effective_from'],
            $input['effective_to'] ?? null,
            $this->idempotencyKey('hr.version.prepare'),
        );

        return redirect()->route('hr.contracts')->with('success', 'Contract version prepared. Add compensation rules, then submit and obtain approval.');
    }

    public function approveVersion(Request $request, string $versionId): RedirectResponse
    {
        $version = ContractVersion::query()->findOrFail($versionId);

        app(MaintainContractVersion::class)->approve(
            $this->actor(),
            $version,
            $this->idempotencyKey('hr.version.approve'),
        );

        return redirect()->route('hr.contracts')->with('success', 'Contract version approved.');
    }

    public function addRule(Request $request, string $versionId): RedirectResponse
    {
        $input = $request->validate([
            'method' => ['required', 'in:fixed_monthly,session_rate,hourly_rate,scale_rate,allowance'],
            'rate' => ['required', 'numeric', 'gte:0'],
            'skill_id' => ['nullable', 'string'],
            'scale_id' => ['nullable', 'string'],
        ]);

        app(MaintainContractVersion::class)->addRule(
            $this->actor(),
            ContractVersion::query()->findOrFail($versionId),
            $input['method'],
            $input['rate'],
            $input['skill_id'] !== null && $input['skill_id'] !== '' ? $input['skill_id'] : null,
            $input['scale_id'] !== null && $input['scale_id'] !== '' ? $input['scale_id'] : null,
            null,
            $this->idempotencyKey('hr.version.rule'),
        );

        return redirect()->route('hr.contracts')->with('success', 'Compensation rule added.');
    }

    public function submitVersion(Request $request, string $versionId): RedirectResponse
    {
        app(MaintainContractVersion::class)->submit(
            $this->actor(),
            ContractVersion::query()->findOrFail($versionId),
            $this->idempotencyKey('hr.version.submit'),
        );

        return redirect()->route('hr.contracts')->with('success', 'Contract version submitted for approval.');
    }

    public function withdrawVersion(Request $request, string $versionId): RedirectResponse
    {
        app(MaintainContractVersion::class)->withdraw(
            $this->actor(),
            ContractVersion::query()->findOrFail($versionId),
            $this->idempotencyKey('hr.version.withdraw'),
        );

        return redirect()->route('hr.contracts')->with('success', 'Contract version withdrawn.');
    }
}
