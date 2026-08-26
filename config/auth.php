<?php

use App\Modules\Identity\Models\UserAccount;

/*
|--------------------------------------------------------------------------
| Authentication
|--------------------------------------------------------------------------
|
| The employee console authenticates through the identity module's user
| account: one active account per verified person, credentials stored
| hashed and set only through the identity command surface. Authority is
| never carried by the session; every operation resolves through the
| canonical access model by the server policy decision.
|
*/

return [

    'defaults' => [
        'guard' => 'web',
    ],

    'guards' => [
        'web' => [
            'driver' => 'session',
            'provider' => 'people',
        ],
    ],

    'providers' => [
        'people' => [
            'driver' => 'eloquent',
            'model' => UserAccount::class,
        ],
    ],

];
