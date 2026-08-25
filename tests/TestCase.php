<?php

declare(strict_types=1);

namespace Tests;

use Illuminate\Foundation\Testing\DatabaseMigrations;

abstract class TestCase extends \Illuminate\Foundation\Testing\TestCase
{
    use DatabaseMigrations;
}
