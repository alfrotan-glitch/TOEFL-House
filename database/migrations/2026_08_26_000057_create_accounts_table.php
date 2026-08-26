<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('accounts', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('code');
            $table->string('name');
            $table->string('type');
            $table->timestamps();
        });
        DB::statement("ALTER TABLE accounts ADD CONSTRAINT accounts_type_check CHECK (type IN ('asset','liability','equity','revenue','expense'))");
        DB::statement('CREATE UNIQUE INDEX accounts_code_unique ON accounts (code)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION accounts_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'chart-of-accounts entries are immutable; a changed definition is a new account';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER accounts_immutable_trigger BEFORE UPDATE OR DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION accounts_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS accounts_immutable_trigger ON accounts');
        DB::statement('DROP FUNCTION IF EXISTS accounts_immutable()');
        Schema::dropIfExists('accounts');
    }
};
