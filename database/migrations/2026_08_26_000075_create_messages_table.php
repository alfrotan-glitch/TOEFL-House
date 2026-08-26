<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('messages', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('subject_person_id', 36);
            $table->char('purpose_id', 36);
            $table->string('channel');
            $table->string('content_ref');
            $table->string('lifecycle_state');
            $table->string('delivery_ref')->nullable();
            $table->char('created_by', 36);
            $table->timestamps();
            $table->foreign('subject_person_id')->references('id')->on('people');
            $table->foreign('purpose_id')->references('id')->on('consent_purposes');
        });
        DB::statement("ALTER TABLE messages ADD CONSTRAINT messages_lifecycle_state_check CHECK (lifecycle_state IN ('queued','sent','failed'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION messages_terminal_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state IN ('sent','failed') THEN
                    RAISE EXCEPTION 'delivered messages are retained communication history';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER messages_terminal_immutable_trigger BEFORE UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION messages_terminal_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS messages_terminal_immutable_trigger ON messages');
        DB::statement('DROP FUNCTION IF EXISTS messages_terminal_immutable()');
        Schema::dropIfExists('messages');
    }
};
