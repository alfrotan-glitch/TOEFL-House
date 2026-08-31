<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('user_accounts', function (Blueprint $table): void {
            // The login form offers "keep me signed in": the framework's
            // recaller mechanism stores its token here. Without this column
            // a remember-enabled sign-in fails. Managed exclusively by the
            // auth guard (never by application code), hence not fillable.
            $table->string('remember_token', 100)->nullable()->after('password_changed_at');
        });
    }

    public function down(): void
    {
        Schema::table('user_accounts', function (Blueprint $table): void {
            $table->dropColumn('remember_token');
        });
    }
};
