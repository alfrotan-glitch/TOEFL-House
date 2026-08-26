<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Employee authentication credential. The identity module already owns the
 * account (one active per verified person); this adds the password hash so
 * an employee can authenticate. Credentials are set only through the
 * identity command surface (never by direct writes), are stored hashed, and
 * are deactivation-retained like the rest of the account history.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('user_accounts', function (Blueprint $table): void {
            $table->string('password_hash')->nullable()->after('username');
        });
        Schema::table('user_accounts', function (Blueprint $table): void {
            $table->timestamp('password_changed_at')->nullable()->after('password_hash');
        });
    }

    public function down(): void
    {
        Schema::table('user_accounts', function (Blueprint $table): void {
            $table->dropColumn(['password_hash', 'password_changed_at']);
        });
    }
};
